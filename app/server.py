"""Quản lý nhà trọ – server chạy local (chỉ dùng thư viện chuẩn của Python).

Chạy:  python server.py            -> http://localhost:8686  (chỉ máy này)
       python server.py --lan      -> mở cho điện thoại cùng mạng Wi-Fi
Quên mật khẩu: python server.py --reset-password <tên đăng nhập> <mật khẩu mới>
Dữ liệu: data/buildings/<mã tòa>/nhatro.db + images/  (mỗi tòa nhà tách riêng)
"""
import base64
import io
import json
import mimetypes
import os
import re
import socket
import sqlite3
import sys
import threading
import uuid
import webbrowser
import zipfile
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import ai
import auth

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
BUILDINGS = os.path.join(DATA, "buildings")  # mỗi tòa nhà 1 thư mục: nhatro.db + images/
STATIC = os.path.join(BASE, "static")
PORT = int(os.environ.get("PORT", "8686"))
MAX_UPLOAD = 15 * 1024 * 1024
CODE_RE = re.compile(r"^[A-Za-z0-9_\-]{1,30}$")

os.makedirs(BUILDINGS, exist_ok=True)
_lock = threading.Lock()
LAN_MODE = False

def lan_urls():
    urls = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        urls.append(f"http://{s.getsockname()[0]}:{PORT}")
        s.close()
    except OSError:
        pass
    return urls


def bdir(b):
    if not b or not CODE_RE.match(b):
        raise ValueError("Mã tòa nhà không hợp lệ")
    return os.path.join(BUILDINGS, b)


def img_dir(b):
    return os.path.join(bdir(b), "images")


def list_buildings():
    out = []
    for name in sorted(os.listdir(BUILDINGS)):
        if CODE_RE.match(name) and os.path.isfile(os.path.join(BUILDINGS, name, "nhatro.db")):
            with db(name) as con:
                s = get_settings(con)
                n = con.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]
            out.append({"code": name, "name": s.get("house_name") or name, "address": s.get("address", ""), "rooms": n})
    return out

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL, status TEXT DEFAULT 'Trống',
  tenant TEXT DEFAULT '', phone TEXT DEFAULT '', move_in TEXT DEFAULT '',
  price REAL DEFAULT 0, people INTEGER DEFAULT 0, vehicles INTEGER DEFAULT 0,
  service_fee REAL DEFAULT 0, deposit REAL DEFAULT 0, note TEXT DEFAULT '',
  area REAL DEFAULT 0, floor TEXT DEFAULT '', max_people INTEGER DEFAULT 0,
  amenities TEXT DEFAULT '', description TEXT DEFAULT '', available_from TEXT DEFAULT '',
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
  filename TEXT NOT NULL, caption TEXT DEFAULT '', sort INTEGER DEFAULT 0,
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, period INTEGER NOT NULL, room_code TEXT NOT NULL,
  old_idx REAL, new_idx REAL, manual_kwh REAL,
  people INTEGER DEFAULT 0, rent REAL DEFAULT 0, service_fee REAL DEFAULT 0, vehicles INTEGER DEFAULT 0,
  elec_price REAL DEFAULT 0, water_price REAL DEFAULT 0, parking_price REAL DEFAULT 0,
  paid INTEGER DEFAULT 0, paid_date TEXT DEFAULT '', note TEXT DEFAULT '',
  UNIQUE(period, room_code)
);
CREATE TABLE IF NOT EXISTS extras (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT DEFAULT '', period INTEGER NOT NULL,
  room_code TEXT NOT NULL, type TEXT DEFAULT '', content TEXT DEFAULT '',
  amount REAL DEFAULT 0, note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT DEFAULT '', period INTEGER NOT NULL,
  category TEXT DEFAULT '', content TEXT DEFAULT '', amount REAL DEFAULT 0,
  room_code TEXT DEFAULT '', method TEXT DEFAULT '', note TEXT DEFAULT '',
  auto TEXT DEFAULT '', estimated INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS room_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, room_code TEXT NOT NULL,
  action TEXT NOT NULL, by_user INTEGER, by_name TEXT DEFAULT '', at TEXT DEFAULT '', listing TEXT DEFAULT '', note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT NOT NULL, tenant TEXT DEFAULT '',
  start_date TEXT DEFAULT '', end_date TEXT DEFAULT '', months INTEGER DEFAULT 12,
  rent REAL DEFAULT 0, deposit REAL DEFAULT 0, data TEXT DEFAULT '{}', html TEXT DEFAULT '',
  created TEXT DEFAULT CURRENT_TIMESTAMP, created_by TEXT DEFAULT ''
);
"""

# Cột thêm sau này: CSDL cũ được tự bổ sung khi mở (không mất dữ liệu)
EXTRA_COLUMNS = {
    "rooms": [("tenant_dob", "TEXT DEFAULT ''"), ("tenant_gender", "TEXT DEFAULT ''"),
              ("tenant_id_no", "TEXT DEFAULT ''"), ("tenant_id_date", "TEXT DEFAULT ''"),
              ("tenant_id_place", "TEXT DEFAULT ''"), ("tenant_address", "TEXT DEFAULT ''"),
              ("tenant_hometown", "TEXT DEFAULT ''"), ("meter_serial", "TEXT DEFAULT ''"),
              # hiển thị cho Sales: '' = ẩn, 'public' = mọi Sales, 'shared' = chỉ Sales được chủ chia sẻ
              ("listing", "TEXT DEFAULT ''"),
              # ngày ra = ngày hết hạn hợp đồng / ngày khách dự kiến trả phòng
              ("move_out", "TEXT DEFAULT ''"),
              # tiến trình gia hạn: '' | 'reminded' (đã nhắc khách) | 'leaving' (khách sẽ ra)
              ("lease_status", "TEXT DEFAULT ''"),
              # đổi giá trị này = mọi mã QR phòng cũ (in trên bill) hết hiệu lực
              ("qr_salt", "TEXT DEFAULT ''"),
              # chốt phòng (lock): Sales / chủ báo đã có khách cọc -> mọi Sales ngừng giới thiệu
              ("lock_by", "INTEGER"), ("lock_by_name", "TEXT DEFAULT ''"), ("lock_at", "TEXT DEFAULT ''"),
              ("lock_note", "TEXT DEFAULT ''")],
    "bills": [("meter_photo", "TEXT DEFAULT ''"),
              ("published_at", "TEXT DEFAULT ''"),     # lúc chủ gửi bill cho khách qua app ('' = khách chưa thấy)
              ("tenant_paid_at", "TEXT DEFAULT ''")],  # lúc khách bấm "Tôi đã chuyển khoản" (chủ kiểm tra rồi tích Đã thu)
}


def ensure_schema(con):
    con.executescript(SCHEMA)
    for t, cols in EXTRA_COLUMNS.items():
        have = {r[1] for r in con.execute(f"PRAGMA table_info({t})")}
        for name, decl in cols:
            if name not in have:
                con.execute(f"ALTER TABLE {t} ADD COLUMN {name} {decl}")

DEFAULT_SETTINGS = {
    "house_name": "Nhà trọ", "address": "", "phone": "",
    "bank_name": "", "bank_bin": "", "account_no": "", "account_name": "",
    "due_day": 5, "elec_price": 3800, "water_price": 100000, "service_fee": 150000,
    "parking_price": 0, "elec_cost": 3412, "water_cost": 100800,
    "banks": [
        ["Vietcombank", "970436"], ["VietinBank", "970415"], ["BIDV", "970418"],
        ["Agribank", "970405"], ["Techcombank", "970407"], ["MB Bank", "970422"],
        ["ACB", "970416"], ["VPBank", "970432"], ["TPBank", "970423"],
        ["Sacombank", "970403"], ["VIB", "970441"], ["HDBank", "970437"],
        ["SHB", "970443"], ["OCB", "970448"], ["MSB", "970426"], ["SeABank", "970440"],
        ["Eximbank", "970431"], ["LPBank", "970449"], ["Nam A Bank", "970428"],
        ["Bac A Bank", "970409"],
    ],
    "expense_categories": [
        {"name": "Tiền thuê nhà", "group": "Nhà", "fixed": 0, "estimate": "", "note": ""},
        {"name": "Điện", "group": "Điện", "fixed": 0, "estimate": "KWH", "note": "Tạm tính = tổng kWh × giá vốn điện"},
        {"name": "Nước", "group": "Nước", "fixed": 0, "estimate": "NGUOI", "note": "Tạm tính = số người × chi phí nước/người"},
        {"name": "Rác", "group": "Dịch vụ", "fixed": 0, "estimate": "", "note": ""},
        {"name": "Wifi", "group": "Dịch vụ", "fixed": 0, "estimate": "", "note": ""},
        {"name": "Sửa chữa", "group": "Khác", "fixed": 0, "estimate": "", "note": ""},
        {"name": "Khác", "group": "Khác", "fixed": 0, "estimate": "", "note": ""},
    ],
    "extra_types": ["Giặt sấy", "Phí trễ hạn", "Đền bù hư hỏng", "Thêm người ở", "Thêm xe", "Giảm trừ", "Khác"],
    "sales_contact": "",
    "sales_commission": "",
    "sales_common": "Giờ giấc tự do, không chung chủ\nCamera an ninh 24/7\nKhu vực để xe rộng",
    "sales_template": (
        "🏠 CHO THUÊ PHÒNG {phong} – {ten_nha}\n"
        "📍 Địa chỉ: {dia_chi}\n"
        "💰 Giá thuê: {gia}/tháng\n"
        "📐 Diện tích: {dien_tich} • Tầng: {tang} • Tối đa: {toi_da}\n"
        "📅 Trống từ: {trong_tu}\n"
        "\n"
        "💡 CHI PHÍ DỊCH VỤ\n"
        "• Điện: {dien}/kWh\n"
        "• Nước: {nuoc}/người/tháng\n"
        "• Phí dịch vụ: {phi_dv}/phòng/tháng\n"
        "• Gửi xe: {xe}\n"
        "• Cọc: {coc}\n"
        "\n"
        "✨ TIỆN ÍCH PHÒNG\n{tien_ich}\n"
        "\n"
        "🏢 TIỆN ÍCH CHUNG\n{tien_ich_chung}\n"
        "\n"
        "{mo_ta}\n"
        "📞 Liên hệ xem phòng: {lien_he}\n"
        "{hoa_hong}"
    ),
    # tự gửi bill qua app: mỗi ngày từ giờ này, bill đã nhập đủ chỉ số của phòng có tài khoản khách sẽ được gửi
    "auto_publish": True, "auto_publish_hour": 20,
    # khu vực (Quận/Huyện, Tỉnh/TP) – để Sales lọc phòng theo khu vực
    "area": "",
    # nhắc hết hạn hợp đồng trước bao nhiêu ngày + tin nhắn mẫu gửi khách
    "remind_days": 30,
    "renew_message": (
        "Chào {ten_khach}, hợp đồng thuê phòng {phong} – {ten_nha} sẽ hết hạn ngày {ngay_het_han} (còn {con_lai} ngày).\n"
        "Anh/chị có muốn tiếp tục thuê không? Vui lòng phản hồi trước ngày {han_tra_loi} để bên em sắp xếp tái ký hợp đồng.\n"
        "Cảm ơn anh/chị! – {lien_he}"
    ),
    # Bên A (chủ trọ) cho hợp đồng
    "landlord_name": "", "landlord_dob": "", "landlord_id_no": "", "landlord_id_date": "", "landlord_id_place": "",
    "landlord_address": "", "landlord_phone": "", "contract_place": "",
    "contract_template": (
        "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\n"
        "Độc lập – Tự do – Hạnh phúc\n"
        "---------------\n"
        "HỢP ĐỒNG THUÊ PHÒNG TRỌ\n"
        "Số: {so_hd}\n"
        "\n"
        "Hôm nay, ngày {ngay_ky}, tại {noi_ky}, chúng tôi gồm:\n"
        "\n"
        "BÊN CHO THUÊ (BÊN A):\n"
        "Ông/Bà: {ben_a_ten}          Ngày sinh: {ben_a_ngay_sinh}\n"
        "CCCD số: {ben_a_cccd}          Ngày cấp: {ben_a_ngay_cap}          Nơi cấp: {ben_a_noi_cap}\n"
        "Địa chỉ thường trú: {ben_a_dia_chi}\n"
        "Điện thoại: {ben_a_sdt}\n"
        "Số tài khoản: {stk}\n"
        "\n"
        "BÊN THUÊ (BÊN B):\n"
        "Ông/Bà: {ben_b_ten}          Ngày sinh: {ben_b_ngay_sinh}          Giới tính: {ben_b_gioi_tinh}\n"
        "CCCD số: {ben_b_cccd}          Ngày cấp: {ben_b_ngay_cap}          Nơi cấp: {ben_b_noi_cap}\n"
        "Nơi thường trú: {ben_b_thuong_tru}\n"
        "Điện thoại: {ben_b_sdt}\n"
        "\n"
        "Hai bên cùng thỏa thuận và đồng ý ký kết hợp đồng thuê phòng trọ với các điều khoản sau:\n"
        "\n"
        "ĐIỀU 1. ĐỐI TƯỢNG HỢP ĐỒNG\n"
        "Bên A đồng ý cho Bên B thuê phòng số {phong} tại địa chỉ {dia_chi_nha}, diện tích khoảng {dien_tich}, để ở. Số người ở tối đa: {so_nguoi} người.\n"
        "Tài sản, trang thiết bị trong phòng bàn giao kèm theo: {tien_ich}.\n"
        "\n"
        "ĐIỀU 2. THỜI HẠN THUÊ\n"
        "Thời hạn thuê là {thoi_han} tháng, kể từ ngày {ngay_bat_dau} đến ngày {ngay_ket_thuc}. Hết hạn, nếu Bên B có nhu cầu tiếp tục thuê thì hai bên gia hạn hoặc ký hợp đồng mới.\n"
        "\n"
        "ĐIỀU 3. GIÁ THUÊ, CHI PHÍ VÀ PHƯƠNG THỨC THANH TOÁN\n"
        "1. Giá thuê phòng: {gia_thue} đồng/tháng (Bằng chữ: {gia_thue_chu}).\n"
        "2. Tiền điện: {dien} đồng/kWh theo chỉ số đồng hồ riêng của phòng. Tiền nước: {nuoc} đồng/người/tháng. Phí dịch vụ: {phi_dv} đồng/phòng/tháng. Gửi xe: {xe}.\n"
        "3. Tiền thuê và các chi phí được thanh toán hằng tháng, chậm nhất ngày {han_thanh_toan} của tháng kế tiếp, bằng tiền mặt hoặc chuyển khoản vào tài khoản của Bên A.\n"
        "4. Giá thuê được giữ nguyên trong thời hạn hợp đồng, trừ khi hai bên có thỏa thuận khác bằng văn bản.\n"
        "\n"
        "ĐIỀU 4. TIỀN ĐẶT CỌC\n"
        "Bên B đặt cọc cho Bên A số tiền {tien_coc} đồng (Bằng chữ: {tien_coc_chu}) để đảm bảo thực hiện hợp đồng. Khi hết hạn hợp đồng, Bên A hoàn trả tiền cọc sau khi trừ các khoản Bên B còn nợ hoặc chi phí sửa chữa hư hỏng do Bên B gây ra (nếu có). Bên B tự ý chấm dứt hợp đồng trước thời hạn mà không báo trước theo Điều 6 thì không được nhận lại tiền cọc.\n"
        "\n"
        "ĐIỀU 5. QUYỀN VÀ NGHĨA VỤ CỦA CÁC BÊN\n"
        "1. Bên A: bàn giao phòng và trang thiết bị đúng thỏa thuận; bảo đảm quyền sử dụng phòng ổn định của Bên B; sửa chữa các hư hỏng không do lỗi của Bên B; hỗ trợ Bên B làm thủ tục đăng ký tạm trú.\n"
        "2. Bên B: sử dụng phòng đúng mục đích; thanh toán đầy đủ, đúng hạn; giữ gìn tài sản, bồi thường nếu làm hư hỏng; chấp hành quy định về an ninh trật tự, phòng cháy chữa cháy, vệ sinh chung và nội quy nhà trọ; không tự ý cho người khác thuê lại; đăng ký tạm trú theo quy định.\n"
        "\n"
        "ĐIỀU 6. CHẤM DỨT HỢP ĐỒNG\n"
        "Bên nào muốn chấm dứt hợp đồng trước thời hạn phải báo cho bên kia trước ít nhất 30 ngày. Bên A có quyền chấm dứt hợp đồng nếu Bên B chậm thanh toán quá 15 ngày hoặc vi phạm nghiêm trọng nội quy, pháp luật.\n"
        "\n"
        "ĐIỀU 7. ĐIỀU KHOẢN KHÁC\n"
        "{dieu_khoan_them}\n"
        "Hai bên cam kết thực hiện đúng các điều khoản trên. Tranh chấp phát sinh được giải quyết trên tinh thần thương lượng; nếu không thương lượng được thì đưa ra cơ quan có thẩm quyền giải quyết.\n"
        "Hợp đồng được lập thành 02 bản có giá trị pháp lý như nhau, mỗi bên giữ 01 bản, có hiệu lực kể từ ngày ký.\n"
    ),
}


def db(b):
    con = sqlite3.connect(os.path.join(bdir(b), "nhatro.db"), timeout=10)
    con.row_factory = sqlite3.Row
    return con


def init_db(b, name=None):
    os.makedirs(img_dir(b), exist_ok=True)
    with db(b) as con:
        ensure_schema(con)
        defaults = dict(DEFAULT_SETTINGS, house_name=name or b)
        for k, v in defaults.items():
            con.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v, ensure_ascii=False)))
    con.close()


def migrate_legacy():
    """Bản cũ lưu ở data/nhatro.db (1 tòa) -> chuyển vào data/buildings/<tên nhà>/."""
    old = os.path.join(DATA, "nhatro.db")
    if not os.path.isfile(old):
        return
    con = sqlite3.connect(old)
    row = con.execute("SELECT value FROM settings WHERE key='house_name'").fetchone()
    con.close()
    code = re.sub(r"[^A-Za-z0-9_\-]", "", json.loads(row[0]) if row else "") or "S01"
    dst = bdir(code)
    if os.path.exists(os.path.join(dst, "nhatro.db")):
        return
    os.makedirs(dst, exist_ok=True)
    os.replace(old, os.path.join(dst, "nhatro.db"))
    old_img = os.path.join(DATA, "images")
    if os.path.isdir(old_img):
        os.replace(old_img, os.path.join(dst, "images"))
    os.makedirs(os.path.join(dst, "images"), exist_ok=True)
    print(f"Đã chuyển dữ liệu cũ sang tòa nhà {code}")


def get_settings(con):
    stored = {r["key"]: json.loads(r["value"]) for r in con.execute("SELECT key,value FROM settings")}
    return {**DEFAULT_SETTINGS, **stored}  # khóa cài đặt mới có giá trị mặc định cho tòa cũ


def rows(con, sql, args=()):
    return [dict(r) for r in con.execute(sql, args)]


TABLES = {
    "rooms": ["code", "status", "tenant", "phone", "move_in", "price", "people", "vehicles", "service_fee",
              "deposit", "note", "area", "floor", "max_people", "amenities", "description", "available_from", "sort",
              "tenant_dob", "tenant_gender", "tenant_id_no", "tenant_id_date", "tenant_id_place", "tenant_address",
              "tenant_hometown", "meter_serial", "listing", "move_out", "lease_status"],
    "bills": ["period", "room_code", "old_idx", "new_idx", "manual_kwh", "people", "rent", "service_fee", "vehicles",
              "elec_price", "water_price", "parking_price", "paid", "paid_date", "note", "meter_photo", "published_at"],
    "contracts": ["room_code", "tenant", "start_date", "end_date", "months", "rent", "deposit", "data", "html"],
    "extras": ["date", "period", "room_code", "type", "content", "amount", "note"],
    "expenses": ["date", "period", "category", "content", "amount", "room_code", "method", "note", "auto", "estimated"],
    "images": ["caption", "sort"],
}


def period_of(d):
    m = re.match(r"(\d{4})-(\d{2})", d or "")
    return int(m.group(1)) * 100 + int(m.group(2)) if m else None


def clean(table, data):
    out = {k: data[k] for k in TABLES[table] if k in data}
    for k, v in list(out.items()):
        if v == "" and k in ("old_idx", "new_idx", "manual_kwh"):
            out[k] = None
    if table in ("extras", "expenses") and not out.get("period"):
        p = period_of(out.get("date") or data.get("date"))
        if p:
            out["period"] = p
    return out


def create_period(con, period, overwrite_rates=False):
    s = get_settings(con)
    today = date.today().isoformat()
    added_bills, added_exp = 0, 0
    rooms_ = rows(con, "SELECT * FROM rooms WHERE status IN ('Đang thuê','Sắp trống') ORDER BY sort, code")
    for r in rooms_:
        if con.execute("SELECT 1 FROM bills WHERE period=? AND room_code=?", (period, r["code"])).fetchone():
            continue
        prev = con.execute(
            "SELECT old_idx,new_idx FROM bills WHERE room_code=? AND period<? ORDER BY period DESC LIMIT 1",
            (r["code"], period)).fetchone()
        old = None
        if prev:
            old = prev["new_idx"] if prev["new_idx"] is not None else prev["old_idx"]
        con.execute(
            "INSERT INTO bills(period,room_code,old_idx,people,rent,service_fee,vehicles,elec_price,water_price,parking_price)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (period, r["code"], old, r["people"], r["price"], r["service_fee"], r["vehicles"],
             s["elec_price"], s["water_price"], s["parking_price"]))
        added_bills += 1
    for c in s.get("expense_categories", []):
        est = c.get("estimate") or ""
        fixed = float(c.get("fixed") or 0)
        if not est and fixed <= 0:
            continue
        auto = est or "fixed"
        if con.execute("SELECT 1 FROM expenses WHERE period=? AND category=? AND auto=?", (period, c["name"], auto)).fetchone():
            continue
        con.execute(
            "INSERT INTO expenses(date,period,category,content,amount,note,auto,estimated) VALUES(?,?,?,?,?,?,?,?)",
            (today, period, c["name"], c["name"], 0 if est else fixed,
             "Tạm tính – gõ số hóa đơn thật khi có" if est else "Tự động (chi cố định)", auto, 1 if est else 0))
        added_exp += 1
    return {"bills": added_bills, "expenses": added_exp}




@contextmanager
def conn(b):
    con = db(b)
    try:
        yield con
        con.commit()
    finally:
        con.close()


# ---------- mã QR phòng (in trên bill): khách quét để xem lịch sử hóa đơn của phòng ----------
SECRET_FILE = os.path.join(DATA, "secret.key")


def _secret():
    if not os.path.isfile(SECRET_FILE):
        with open(SECRET_FILE, "wb") as f:
            f.write(os.urandom(32))
    with open(SECRET_FILE, "rb") as f:
        return f.read()


def _sign(payload):
    import hmac
    return hmac.new(_secret(), payload.encode(), "sha256").hexdigest()[:20]


def room_since(r):
    return period_of(r["move_in"]) or 0


def room_token(b, r):
    """Mã gắn với khách hiện tại của phòng: đổi ngày vào (khách mới) hoặc đổi qr_salt thì mã cũ hết hiệu lực."""
    payload = base64.urlsafe_b64encode(json.dumps([b, r["code"], room_since(r), r.get("qr_salt") or ""],
                                                  ensure_ascii=False).encode()).decode().rstrip("=")
    return payload + "." + _sign(payload)


def verify_room_token(tok):
    import hmac
    try:
        payload, sig = (tok or "").rsplit(".", 1)
        if not hmac.compare_digest(sig, _sign(payload)):
            raise ValueError
        b, code, since, salt = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, TypeError):
        raise auth.AuthError("Mã QR không hợp lệ")
    if not CODE_RE.match(b) or not os.path.isfile(os.path.join(bdir(b), "nhatro.db")):
        raise auth.AuthError("Mã QR không hợp lệ")
    with conn(b) as con:
        r = con.execute("SELECT * FROM rooms WHERE code=?", (code,)).fetchone()
        s = get_settings(con)
    if not r or r["status"] == "Trống" or room_since(r) != since or (r["qr_salt"] or "") != salt:
        raise auth.AuthError("Mã QR đã hết hiệu lực (phòng đã đổi khách hoặc chủ đã đổi mã) – nhờ chủ trọ gửi mã mới")
    t = date.today()
    return {"building": b, "room": dict(r), "since": since or t.year * 100 + t.month, "house": s.get("house_name") or b,
            "address": s.get("address") or "", "auto_publish": s.get("auto_publish", True)}


def area_of(s):
    """Khu vực của tòa: ô 'Khu vực' trong Cài đặt, nếu trống thì lấy 2 phần cuối của địa chỉ (vd 'Quận 3, TP.HCM')."""
    if (s.get("area") or "").strip():
        return s["area"].strip()
    parts = [p.strip() for p in (s.get("address") or "").split(",") if p.strip()]
    return ", ".join(parts[-2:]) if len(parts) >= 2 else ""


PII_FIELDS = ("tenant_dob", "tenant_gender", "tenant_id_no", "tenant_id_date", "tenant_id_place", "tenant_address", "tenant_hometown")


def dump_all(b, scope=None):
    """scope (từ link chia sẻ / sang nhượng): from_period = chỉ gửi thu chi từ kỳ này; pii=False = ẩn CCCD khách."""
    scope = scope or {}
    since = int(scope.get("from_period") or 0)
    with conn(b) as con:
        d = {
            "settings": get_settings(con),
            "rooms": rows(con, "SELECT * FROM rooms ORDER BY sort, code"),
            "images": rows(con, "SELECT * FROM images ORDER BY room_id, sort, id"),
            "bills": rows(con, "SELECT * FROM bills WHERE period>=? ORDER BY period, room_code", (since,)),
            "extras": rows(con, "SELECT * FROM extras WHERE period>=? ORDER BY period, date, id", (since,)),
            "expenses": rows(con, "SELECT * FROM expenses WHERE period>=? ORDER BY period, date, id", (since,)),
            "contracts": rows(con, "SELECT id, room_code, tenant, start_date, end_date, months, rent, deposit, created, created_by"
                                   " FROM contracts ORDER BY id DESC"),
        }
    d["tenant_links"] = auth.tenant_links_building(b)
    for r in d["rooms"]:  # mã QR phòng để in trên bill (chỉ phòng đang có khách)
        r["access_token"] = room_token(b, r) if r["status"] != "Trống" else ""
    if scope and not scope.get("pii"):
        for r in d["rooms"]:
            r["access_token"] = ""
        for r in d["rooms"]:
            for k in PII_FIELDS:
                r[k] = ""
        d["contracts"] = []
        d["tenant_links"] = []
    d["scope"] = scope
    return d


# ---------- quyền cần để sửa từng trường ----------
BILL_CAP = {"new_idx": "readings", "manual_kwh": "readings", "note": "readings",
            "paid": "payments", "paid_date": "payments", "meter_photo": "readings",
            "published_at": "payments"}  # trường khác của bill -> "bills"
ROOM_PRICE_FIELDS = {"price", "service_fee", "deposit"}  # -> "prices"; trường khác của phòng -> "rooms"
SETTING_CAP = {k: "bank" for k in ("bank_name", "bank_bin", "account_no", "account_name")}
SETTING_CAP.update({k: "prices" for k in ("elec_price", "water_price", "service_fee", "parking_price", "elec_cost", "water_cost")})
CAP_LABEL = dict(auth.CAPS)


def _norm(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    try:
        return float(v) if re.fullmatch(r"-?\d+(\.\d+)?", str(v)) else str(v)
    except ValueError:
        return str(v)


def changed_fields(old, new):
    return [k for k, v in new.items() if _norm(v) != _norm(old.get(k))]


def field_cap(table, field):
    if table == "bills":
        return BILL_CAP.get(field, "bills")
    if table == "rooms":
        return "prices" if field in ROOM_PRICE_FIELDS else "rooms"
    return {"extras": "extras", "expenses": "expenses", "images": "rooms", "contracts": "rooms"}[table]


def all_building_codes():
    return [n for n in sorted(os.listdir(BUILDINGS))
            if CODE_RE.match(n) and os.path.isfile(os.path.join(BUILDINGS, n, "nhatro.db"))]


class Handler(BaseHTTPRequestHandler):
    server_version = "NhaTro/3.0"
    user = None
    role = None
    caps = frozenset()
    scope = None

    def log_message(self, fmt, *args):
        pass

    # ---------- helpers ----------
    def send_json(self, obj, code=200, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            age = auth.SESSION_DAYS * 86400 if cookie else 0
            self.send_header("Set-Cookie", f"sid={cookie}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, ctype, download_name=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store")
        if download_name:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote_name(download_name)}")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        if not os.path.isfile(path):
            return self.send_json({"error": "not found"}, 404)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            self.send_bytes(f.read(), ctype)

    def body_bytes(self, limit=MAX_UPLOAD):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("File quá lớn")
        return self.rfile.read(n) if n else b""

    def body_json(self):
        b = self.body_bytes()
        return json.loads(b.decode("utf-8")) if b else {}

    def parts(self):
        u = urlparse(self.path)
        return [unquote(p) for p in u.path.strip("/").split("/") if p], parse_qs(u.query)

    def token(self):
        m = re.search(r"(?:^|;\s*)sid=([A-Za-z0-9_\-]+)", self.headers.get("Cookie") or "")
        return m.group(1) if m else None

    # ---------- quyền ----------
    def enter_building(self, b):
        if not b or not CODE_RE.match(b) or not os.path.isfile(os.path.join(bdir(b), "nhatro.db")):
            raise LookupError(f"Không có tòa nhà {b}")
        m = auth.membership(b, self.user["id"])
        if not m:
            raise PermissionError("Bạn không có quyền với tòa nhà này")
        self.role, self.caps, self.scope = m[0], frozenset(m[1]), m[2]
        return b

    def building(self, q):
        b = (q.get("b") or [None])[0] or self.headers.get("X-Building")
        if not b:
            mine = sorted(auth.my_buildings(self.user["id"]))
            if not mine:
                raise LookupError("Bạn chưa có tòa nhà nào")
            b = mine[0]
        return self.enter_building(b)

    def need(self, *caps):
        miss = [c for c in caps if c not in self.caps]
        if miss:
            raise PermissionError("Bạn không có quyền: " + ", ".join(CAP_LABEL.get(c, c) for c in miss))

    def need_fields(self, table, fields):
        self.need(*sorted({field_cap(table, f) for f in fields}))

    # ---------- đăng ký / đăng nhập ----------
    def auth_routes(self, method, p):
        if p == ["api", "auth-status"]:
            u = auth.user_by_token(self.token())
            self.send_json({"user": u, "first": auth.user_count() == 0})
            return True
        if p == ["api", "room-claim-info"]:  # quét QR phòng: chỉ trả tên nhà + mã phòng (chưa cần đăng nhập)
            info = verify_room_token((parse_qs(urlparse(self.path).query).get("token") or [""])[0])
            self.send_json({"house": info["house"], "room": info["room"]["code"], "address": info["address"], "building": info["building"]})
            return True
        if p == ["api", "setup-info"]:  # khách quét QR: xem tài khoản sắp đặt mật khẩu
            self.send_json(auth.setup_info((parse_qs(urlparse(self.path).query).get("token") or [""])[0]))
            return True
        if p == ["api", "setup"] and method == "POST":
            d = self.body_json()
            tok, u = auth.setup_password(d.get("token"), d.get("password"))
            self.send_json({"user": u}, cookie=tok)
            return True
        if method != "POST":
            return False
        if p == ["api", "register"]:
            d = self.body_json()
            first = auth.user_count() == 0
            # tự đăng ký: chủ trọ, sales hoặc khách thuê (nhân viên do chủ trọ tạo)
            kind = d.get("kind") if d.get("kind") in ("sales", "tenant") else "owner"
            if d.get("room_token"):  # khách quét QR phòng: SĐT đã được chủ tạo sẵn -> kích hoạt luôn
                info = verify_room_token(d["room_token"])
                act = auth.activate_with_claim(d.get("username"), d.get("password"), info["building"], info["room"]["code"],
                                               info["room"]["phone"])
                if act:
                    tok, u = act
                    self.send_json({"user": u, "first": False}, cookie=tok)
                    return True
            u = auth.register(d.get("username"), d.get("name"), d.get("password"), kind=kind, phone=d.get("phone"))
            if first:
                auth.claim_orphans(all_building_codes())
            tok, u = auth.login(d.get("username"), d.get("password"))
            self.send_json({"user": u, "first": first}, cookie=tok)
            return True
        if p == ["api", "login"]:
            d = self.body_json()
            tok, u = auth.login(d.get("username"), d.get("password"))
            self.send_json({"user": u}, cookie=tok)
            return True
        if p == ["api", "logout"]:
            auth.logout(self.token())
            self.send_json({"ok": True}, cookie="")
            return True
        return False

    def run(self, fn):
        try:
            p, q = self.parts()
            if p and p[0] == "api" and self.auth_routes(self.command, p):
                return
            if p and p[0] in ("api", "img"):
                self.user = auth.user_by_token(self.token())
                if not self.user:
                    return self.send_json({"error": "auth"}, 401)
            fn(p, q)
        except auth.AuthError as e:
            self.send_json({"error": str(e)}, 400)
        except PermissionError as e:
            self.send_json({"error": str(e)}, 403)
        except LookupError as e:
            self.send_json({"error": str(e)}, 404)
        except sqlite3.IntegrityError as e:
            self.send_json({"error": "Dữ liệu bị trùng: " + str(e)}, 400)
        except Exception as e:  # noqa
            self.send_json({"error": str(e)}, 500)

    def send_zip_images(self, b, rid):
        with conn(b) as con:
            room = con.execute("SELECT code FROM rooms WHERE id=?", (rid,)).fetchone()
            imgs = rows(con, "SELECT * FROM images WHERE room_id=? ORDER BY sort,id", (rid,))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            for i, im in enumerate(imgs, 1):
                fp = os.path.join(img_dir(b), im["filename"])
                if os.path.isfile(fp):
                    z.write(fp, f"{room['code']}_{i:02d}{os.path.splitext(fp)[1]}")
        return self.send_bytes(buf.getvalue(), "application/zip", f"{b}_{room['code'] if room else 'phong'}_anh.zip")

    # ---------- chợ phòng cho Sales ----------
    MARKET_STATUS = ("Trống", "Sắp trống")

    def market_room(self, b, rid):
        """Phòng có đang mở cho người dùng hiện tại xem (công khai, hoặc chia sẻ riêng cho họ) không."""
        if not CODE_RE.match(b or "") or not os.path.isfile(os.path.join(bdir(b), "nhatro.db")):
            return False
        with conn(b) as con:
            r = con.execute("SELECT listing, status FROM rooms WHERE id=?", (rid,)).fetchone()
        if not r or r["status"] not in self.MARKET_STATUS:
            return False
        return r["listing"] == "public" or (r["listing"] == "shared" and (
            b in auth.shared_buildings(self.user["id"]) or (b, rid) in auth.room_shares_for(self.user["id"])))

    def market_list(self):
        shared = auth.shared_buildings(self.user["id"])
        sent = auth.room_shares_for(self.user["id"])  # phòng chủ trọ gửi riêng cho mình qua danh bạ
        out = []
        for b in all_building_codes():
            with conn(b) as con:
                s = get_settings(con)
                rs = rows(con, "SELECT id, code, status, price, area, floor, max_people, amenities, description,"
                               " available_from, deposit, service_fee, listing, lock_by, lock_by_name, lock_at FROM rooms"
                               " WHERE status IN ('Trống','Sắp trống') AND listing IN ('public','shared') ORDER BY sort, code")
                rs = [r for r in rs if r["listing"] == "public" or b in shared or (b, r["id"]) in sent]
                for r in rs:
                    r["shared_at"] = sent.get((b, r["id"]), "")
                if not rs:
                    continue
                imgs = rows(con, "SELECT room_id, filename FROM images ORDER BY room_id, sort, id")
            admins = auth.building_admins(b)
            owner = {"name": s.get("landlord_name") or (admins[0]["name"] if admins else ""),
                     "phone": s.get("landlord_phone") or s.get("phone") or (admins[0]["phone"] if admins else ""),
                     "contact": s.get("sales_contact") or "", "commission": s.get("sales_commission") or ""}
            # chỉ gửi phần cài đặt cần cho tin đăng – không gửi STK, khách thuê, hóa đơn
            pub = {k: s.get(k) for k in ("house_name", "address", "phone", "sales_contact", "sales_commission", "sales_common",
                                         "sales_template", "elec_price", "water_price", "service_fee", "parking_price")}
            pub["area"] = area_of(s)
            for r in rs:
                r["images"] = [f"/img/{b}/{i['filename']}" for i in imgs if i["room_id"] == r["id"]]
                r["locked_by_me"] = bool(r["lock_at"]) and r["lock_by"] == self.user["id"]
                r.pop("lock_by", None)
                out.append({"building": b, "settings": pub, "owner": owner, "room": r, "via": "shared" if r["listing"] == "shared" else "public"})
        return out

    # ---------- chốt phòng (lock) ----------
    def lock_room(self, b, rid, note, by_owner):
        """Chốt phòng: chỉ 1 người chốt được (khóa trong transaction) – người đến sau nhận báo 'đã có người chốt'."""
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        name = self.user["name"] + ("" if by_owner else f" (Sales {self.user['username']})")
        with _lock, conn(b) as con:
            r = con.execute("SELECT * FROM rooms WHERE id=?", (rid,)).fetchone()
            if not r:
                raise LookupError("Không có phòng")
            if r["lock_at"]:
                raise auth.AuthError(f"Phòng {r['code']} đã được {r['lock_by_name']} chốt lúc {r['lock_at']}")
            con.execute("UPDATE rooms SET lock_by=?, lock_by_name=?, lock_at=?, lock_note=? WHERE id=?",
                        (self.user["id"], name, now, (note or "").strip()[:200], rid))
            con.execute("INSERT INTO room_events(room_id,room_code,action,by_user,by_name,at,listing,note) VALUES(?,?,?,?,?,?,?,?)",
                        (rid, r["code"], "lock", self.user["id"], name, now, r["listing"], (note or "").strip()[:200]))
            return {"room": r["code"], "lock_at": now, "lock_by_name": name}

    def unlock_room(self, b, rid, by_owner):
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        with _lock, conn(b) as con:
            r = con.execute("SELECT * FROM rooms WHERE id=?", (rid,)).fetchone()
            if not r or not r["lock_at"]:
                raise auth.AuthError("Phòng chưa được chốt")
            if not by_owner and r["lock_by"] != self.user["id"]:
                raise PermissionError("Chỉ người đã chốt (hoặc chủ trọ) mới hủy chốt được")
            con.execute("UPDATE rooms SET lock_by=NULL, lock_by_name='', lock_at='', lock_note='' WHERE id=?", (rid,))
            con.execute("INSERT INTO room_events(room_id,room_code,action,by_user,by_name,at,listing) VALUES(?,?,?,?,?,?,?)",
                        (rid, r["code"], "unlock", self.user["id"], self.user["name"], now, r["listing"]))
            return {"room": r["code"]}

    def sales_lock_events(self, days=3):
        """Thông báo cho Sales: phòng họ được thấy vừa bị chốt / mở lại (kể cả khi chủ đã gỡ khỏi danh sách)."""
        shared = auth.shared_buildings(self.user["id"])
        sent = auth.room_shares_for(self.user["id"])
        since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M")
        out = []
        for b in all_building_codes():
            with conn(b) as con:
                ev = rows(con, "SELECT * FROM room_events WHERE at>=? AND action IN ('lock','unlock') ORDER BY at DESC", (since,))
                if not ev:
                    continue
                house = get_settings(con).get("house_name") or b
            for e in ev:
                if e["by_user"] == self.user["id"]:
                    continue
                if e["listing"] == "public" or b in shared or (b, e["room_id"]) in sent:
                    out.append({"type": "lock_event", "building": b, "house": house, "room": e["room_code"], "room_id": e["room_id"],
                                "action": e["action"], "by": e["by_name"], "at": e["at"]})
        return sorted(out, key=lambda x: x["at"], reverse=True)

    # ---------- khách thuê ----------
    def tenant_bills(self, link, con):
        until = link["until_period"] or 999999
        return rows(con, "SELECT * FROM bills WHERE room_code=? AND period>=? AND period<=? AND published_at<>'' ORDER BY period DESC",
                    (link["room_code"], link["since_period"], until))

    def tenant_data(self):
        """Người thuê (mọi loại tài khoản có phòng gắn theo SĐT): phòng mình ở (hiện tại + đã ở) và hóa đơn chủ đã gửi."""
        out = []
        for l in auth.tenant_links_of(self.user["id"]):
            if not os.path.isfile(os.path.join(bdir(l["building"]), "nhatro.db")):
                continue
            with conn(l["building"]) as con:
                s = get_settings(con)
                room = con.execute("SELECT code, tenant, phone, move_in, move_out, price, deposit FROM rooms WHERE code=?", (l["room_code"],)).fetchone()
                bills = self.tenant_bills(l, con)
                pers = {b["period"] for b in bills}
                extras = [e for e in rows(con, "SELECT * FROM extras WHERE room_code=?", (l["room_code"],)) if e["period"] in pers]
            admins = auth.building_admins(l["building"])
            pub = {k: s.get(k) for k in ("house_name", "address", "phone", "bank_name", "bank_bin", "account_no", "account_name",
                                          "due_day", "elec_price", "water_price", "service_fee", "parking_price", "landlord_name", "landlord_phone")}
            out.append({"link_id": l["id"], "building": l["building"], "active": bool(l["active"]), "since": l["since_period"],
                        "until": l["until_period"], "settings": pub,
                        # đã trả phòng: không gửi thông tin phòng hiện tại (có thể là của khách mới), chỉ mã phòng + tên mình
                        "room": dict(room) if room and l["active"] else {"code": l["room_code"], "tenant": self.user["name"]},
                        "bills": bills, "extras": extras,
                        "owner": {"name": s.get("landlord_name") or (admins[0]["name"] if admins else ""),
                                  "phone": s.get("landlord_phone") or s.get("phone") or (admins[0]["phone"] if admins else "")}})
        return out

    def sync_room_tenant(self, b, r):
        """Tự động theo SĐT phòng: tạo tài khoản khách (hoặc gắn tài khoản SĐT đã có) khi phòng có người thuê;
        ngắt khi phòng chuyển sang Trống. Trả về thông tin để giao diện báo lại chủ trọ."""
        today_ = date.today()
        cur = today_.year * 100 + today_.month
        if r["status"] == "Trống":
            return {"ended": auth.end_tenant(b, r["code"], cur)} if r["code"] else None
        phone = auth.norm_phone(r["phone"])
        if not phone:
            return None
        if not auth.PHONE_RE.match(phone):
            return {"error": f"SĐT “{r['phone']}” không hợp lệ – chưa tạo được tài khoản app cho khách"}
        try:
            res = auth.link_tenant(b, r["code"], phone, r["tenant"], period_of(r["move_in"]) or cur, self.user["id"])
        except auth.AuthError as e:
            return {"error": str(e)}
        return dict(res, room_code=r["code"], room_id=r["id"])

    def tenant_report_paid(self, d):
        for l in auth.tenant_links_of(self.user["id"]):
            if l["building"] != d.get("building"):
                continue
            with _lock, conn(l["building"]) as con:
                ok = [b for b in self.tenant_bills(l, con) if b["id"] == int(d.get("bill_id") or 0)]
                if ok:
                    con.execute("UPDATE bills SET tenant_paid_at=? WHERE id=?", (datetime.now().strftime("%Y-%m-%d %H:%M"), ok[0]["id"]))
                    return self.send_json({"ok": True})
        raise PermissionError("Không phải hóa đơn của bạn")

    # ---------- thông báo ----------
    def notifications(self):
        """Chủ trọ / quản lý: phòng sắp hết hạn hợp đồng (theo ngày ra). Sales: phòng mới được gửi cho mình."""
        today_ = date.today()
        items = []
        if self.user["kind"] == "tenant":  # hóa đơn đã gửi mà chưa thanh toán
            for t in self.tenant_data():
                for b in t["bills"]:
                    if not b["paid"]:
                        items.append({"type": "bill", "building": t["building"], "house": t["settings"]["house_name"], "room": b["room_code"],
                                      "period": b["period"], "bill_id": b["id"], "reported": bool(b["tenant_paid_at"])})
            return items
        if self.user["kind"] == "sales":
            sent = auth.room_shares_for(self.user["id"])
            for it in self.market_list():
                t = sent.get((it["building"], it["room"]["id"]))
                if t and (today_ - date.fromisoformat(t[:10])).days <= 7 and not it["room"]["lock_at"]:
                    items.append({"type": "shared", "building": it["building"], "house": it["settings"]["house_name"],
                                  "room": it["room"]["code"], "room_id": it["room"]["id"], "at": t, "price": it["room"]["price"]})
            items += self.sales_lock_events()  # phòng vừa có người chốt / mở lại -> ngừng / tiếp tục giới thiệu
            return sorted(items, key=lambda x: x["at"], reverse=True)
        for b in auth.my_buildings(self.user["id"]):
            if not os.path.isfile(os.path.join(bdir(b), "nhatro.db")):
                continue
            with conn(b) as con:
                s = get_settings(con)
                rs = rows(con, "SELECT id, code, status, tenant, phone, move_in, move_out, lease_status, listing FROM rooms"
                               " WHERE move_out<>'' AND status IN ('Đang thuê','Sắp trống')")
                claims = rows(con, "SELECT id, period, room_code, tenant_paid_at FROM bills WHERE tenant_paid_at<>'' AND paid=0")
                locks = rows(con, "SELECT id, code, lock_by_name, lock_at, lock_note, listing FROM rooms WHERE lock_at<>'' AND listing<>''")
            for c in claims:  # khách báo đã chuyển khoản -> chủ kiểm tra tài khoản rồi tích Đã thu
                items.append(dict(c, type="paid_claim", building=b, house=s.get("house_name") or b, days_left=-999))
            for l in locks:  # phòng đã được chốt mà vẫn đang gửi Sales -> nhắc chủ gỡ cờ
                items.append(dict(l, type="room_locked", building=b, house=s.get("house_name") or b, days_left=-998))
            days = int(s.get("remind_days") or 30)
            for r in rs:
                try:
                    left = (date.fromisoformat(r["move_out"]) - today_).days
                except ValueError:
                    continue
                if left <= days:
                    items.append(dict(r, type="lease", building=b, house=s.get("house_name") or b, days_left=left))
        return sorted(items, key=lambda x: x["days_left"])

    # ---------- GET ----------
    def do_GET(self):
        self.run(self._get)

    def _get(self, p, q):
        if not p:
            return self.send_file(os.path.join(STATIC, "index.html"))
        if p in (["manifest.webmanifest"], ["sw.js"]):  # để "Thêm vào màn hình chính" mở như app
            return self.send_file(os.path.join(STATIC, p[0]))
        if p[0] == "static":
            path = os.path.normpath(os.path.join(STATIC, *p[1:]))
            if not path.startswith(STATIC):
                return self.send_json({"error": "forbidden"}, 403)
            return self.send_file(path)
        if p[0] == "img" and len(p) == 3 and re.fullmatch(r"[\w\-.]+", p[2]):
            if not auth.membership(p[1], self.user["id"]):
                # không phải thành viên: chỉ xem được ảnh phòng đang mở cho Sales mà mình được thấy
                with conn(p[1]) as con:
                    im = con.execute("SELECT room_id FROM images WHERE filename=?", (p[2],)).fetchone()
                if not im or not self.market_room(p[1], im["room_id"]):
                    raise PermissionError("Không có quyền xem ảnh này")
            return self.send_file(os.path.join(img_dir(p[1]), p[2]))
        if p == ["api", "tenant"]:
            return self.send_json(self.tenant_data())
        if p == ["api", "market"]:
            if self.user["kind"] == "tenant":
                raise PermissionError("Tài khoản khách không xem chợ phòng")
            return self.send_json(self.market_list())
        if p == ["api", "notifications"]:
            return self.send_json(self.notifications())
        if p == ["api", "invite-info"]:
            info = auth.invite_info((q.get("token") or [""])[0])
            with conn(info["building"]) as con:
                s = get_settings(con)
                n = con.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]
            return self.send_json(dict(info, name=s.get("house_name"), address=s.get("address"), rooms=n))
        if p == ["api", "sales-contacts"]:
            return self.send_json(auth.contacts(self.user["id"]))
        if p == ["api", "export.xlsx"]:
            import export_xlsx
            if (q.get("all") or ["0"])[0] == "1":  # mọi tòa mình là thành viên, gộp 1 file
                codes = [c for c in sorted(auth.my_buildings(self.user["id"])) if os.path.isfile(os.path.join(bdir(c), "nhatro.db"))]
            else:
                codes = [self.building(q)]
            if not codes:
                raise LookupError("Bạn chưa có tòa nhà nào")
            data = []
            for c in codes:
                self.enter_building(c)  # áp đúng phạm vi được xem của từng tòa
                data.append((c, dump_all(c, self.scope)))
            name = ("TatCaToa" if len(codes) > 1 else codes[0]) + f"_{date.today().isoformat()}.xlsx"
            return self.send_bytes(export_xlsx.build(data, self.user["name"]),
                                   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name)
        if len(p) == 5 and p[:2] == ["api", "market"] and p[4] == "images.zip":
            b, rid = p[2], int(p[3])
            if not self.market_room(b, rid):
                raise PermissionError("Phòng không mở cho bạn")
            return self.send_zip_images(b, rid)
        if p == ["api", "buildings"]:
            auth.claim_orphans(all_building_codes())
            mine = auth.my_buildings(self.user["id"])
            return self.send_json([dict(b, **mine[b["code"]]) for b in list_buildings() if b["code"] in mine])
        if p == ["api", "meta"]:
            return self.send_json({"caps": auth.CAPS, "roles": {k: sorted(v) for k, v in auth.ROLES.items()},
                                   "role_label": auth.ROLE_LABEL, "lan": LAN_MODE, "urls": lan_urls() if LAN_MODE else [],
                                   "system_owner": auth.is_system_owner(self.user["id"]), "ai": ai.status(),
                                   "my_rooms": len(auth.tenant_links_of(self.user["id"]))})  # số phòng mình thuê (theo SĐT)
        b = self.building(q)
        if p == ["api", "all"]:
            return self.send_json(dump_all(b, self.scope))
        if len(p) == 3 and p[:2] == ["api", "contracts"]:
            with conn(b) as con:
                if self.scope and not self.scope.get("pii"):
                    raise PermissionError("Link chia sẻ không bao gồm hợp đồng / thông tin cá nhân khách")
                r = con.execute("SELECT * FROM contracts WHERE id=?", (int(p[2]),)).fetchone()
            return self.send_json(dict(r)) if r else self.send_json({"error": "Không tìm thấy"}, 404)
        if p == ["api", "members"]:
            return self.send_json(auth.members(b))
        if p == ["api", "sales-shares"]:
            return self.send_json(auth.sales_shares(b))
        if p == ["api", "invites"]:
            self.need("members")
            return self.send_json(auth.list_invites(b))
        if len(p) == 4 and p[:2] == ["api", "rooms"] and p[3] == "images.zip":
            return self.send_zip_images(b, int(p[2]))
        if p == ["api", "backup"]:
            self.need("settings")
            buf = io.BytesIO()
            tmp = os.path.join(DATA, f"_backup_{b}.db")
            with _lock:
                src = db(b)
                dst = sqlite3.connect(tmp)
                src.backup(dst)
                dst.close(); src.close()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                z.write(tmp, "nhatro.db")
                for f in os.listdir(img_dir(b)):
                    z.write(os.path.join(img_dir(b), f), "images/" + f)
            os.remove(tmp)
            return self.send_bytes(buf.getvalue(), "application/zip", f"{b}_backup_{date.today().isoformat()}.zip")
        self.send_json({"error": "not found"}, 404)

    # ---------- POST ----------
    def do_POST(self):
        self.run(self._post)

    def _post(self, p, q):
        if p == ["api", "change-password"]:
            d = self.body_json()
            auth.change_password(self.user["id"], d.get("old"), d.get("new"), keep_token=self.token())
            return self.send_json({"ok": True})
        if p == ["api", "buildings"]:  # chủ trọ / nhân viên tạo được tòa mới, người tạo = chủ trọ của tòa
            if self.user["kind"] in ("sales", "tenant"):
                raise PermissionError("Tài khoản Sales không tạo tòa nhà")
            d = self.body_json()
            code = (d.get("code") or "").strip()
            if not CODE_RE.match(code):
                return self.send_json({"error": "Mã tòa nhà chỉ gồm chữ, số, - _ (vd S03)"}, 400)
            if os.path.isfile(os.path.join(bdir(code), "nhatro.db")):
                return self.send_json({"error": f"Mã {code} đã được dùng, chọn mã khác"}, 400)
            with _lock:
                init_db(code, d.get("name") or code)
                auth.grant(code, self.user["id"], "admin")
                with conn(code) as con:
                    for k in ("address", "phone"):
                        if d.get(k):
                            con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(d[k], ensure_ascii=False)))
            return self.send_json({"ok": True})
        if len(p) >= 3 and p[:2] == ["api", "ai"]:
            return self.ai_routes(p, q)
        if p == ["api", "invites", "accept"]:
            return self.send_json(auth.accept_invite(self.body_json().get("token"), self.user["id"]))
        if p == ["api", "tenant", "report-paid"]:
            return self.tenant_report_paid(self.body_json())
        if len(p) == 5 and p[:2] == ["api", "market"] and p[4] in ("lock", "unlock"):  # Sales chốt / hủy chốt phòng
            b, rid = p[2], int(p[3])
            if self.user["kind"] == "tenant":
                raise PermissionError("Tài khoản khách không chốt phòng")
            if p[4] == "lock":
                if not self.market_room(b, rid):
                    raise PermissionError("Phòng không mở cho bạn")
                return self.send_json(self.lock_room(b, rid, self.body_json().get("note"), by_owner=False))
            return self.send_json(self.unlock_room(b, rid, by_owner=False))
        if p == ["api", "room-claim"]:  # đã đăng nhập + quét QR phòng -> xem lịch sử hóa đơn phòng
            info = verify_room_token(self.body_json().get("token"))
            b, code = info["building"], info["room"]["code"]
            new = auth.claim_room(b, code, self.user["id"], info["since"])
            if info["auto_publish"]:  # chủ bật tự gửi: các bill đủ chỉ số của khách hiện tại hiện luôn
                now = datetime.now().strftime("%Y-%m-%d %H:%M")
                with _lock, conn(b) as con:
                    con.execute("UPDATE bills SET published_at=? WHERE room_code=? AND published_at='' AND period>=? "
                                "AND (new_idx IS NOT NULL OR manual_kwh>0)", (now, code, info["since"]))
            return self.send_json({"building": b, "room": code, "house": info["house"], "new": new})
        if self.user["kind"] == "tenant":
            raise PermissionError("Tài khoản khách chỉ xem hóa đơn của mình")
        if p == ["api", "sales-contacts"]:
            if self.user["kind"] == "sales":
                raise PermissionError("Chỉ chủ trọ / quản lý có danh bạ Sales")
            d = self.body_json()
            auth.add_contact(self.user["id"], d.get("name"), d.get("phone"), d.get("username"), d.get("note"))
            return self.send_json(auth.contacts(self.user["id"]))
        b = self.building(q)
        if p == ["api", "invites"]:
            d = self.body_json()
            transfer = d.get("purpose") == "transfer"
            # sang nhượng = trao toàn quyền -> người tạo phải có toàn quyền; xem trước -> cần quyền chia sẻ
            self.need(*(auth.CAP_KEYS if transfer else ["members"]))
            scope = None
            if not transfer:
                months = int(d.get("months") or 0)
                since = None
                if months > 0:
                    with conn(b) as con:
                        last = con.execute("SELECT MAX(period) FROM bills").fetchone()[0]
                    if last:
                        y, m = divmod(int(last), 100)
                        m -= months - 1
                        while m < 1:
                            m += 12
                            y -= 1
                        since = y * 100 + m
                scope = {"from_period": since, "pii": bool(d.get("pii")), "months": months}
            tok = auth.create_invite(b, self.user["id"], "admin" if transfer else "viewer", scope, transfer, d.get("days") or 7)
            return self.send_json({"token": tok, "invites": auth.list_invites(b)})
        if p == ["api", "tenant-accounts", "sync"]:  # tạo / gắn tài khoản app cho mọi khách đang thuê của tòa
            self.need("rooms")
            with conn(b) as con:
                rooms_ = rows(con, "SELECT id, code, status, tenant, phone, move_in FROM rooms ORDER BY sort, code")
            out = []
            for r in rooms_:
                if r["status"] == "Trống":
                    continue
                res = self.sync_room_tenant(b, r)
                out.append(dict(res or {"skipped": "chưa có SĐT"}, room_code=r["code"], room_id=r["id"], tenant=r["tenant"]))
            return self.send_json(out)
        if len(p) == 4 and p[:2] == ["api", "rooms"] and p[3] == "tenant-account":
            self.need("rooms")
            d = self.body_json()
            with conn(b) as con:
                r = con.execute("SELECT code, tenant, phone, move_in FROM rooms WHERE id=?", (int(p[2]),)).fetchone()
            if not r:
                return self.send_json({"error": "Không có phòng"}, 404)
            act = d.get("action") or "create"
            if act == "create":
                with conn(b) as con:
                    full = dict(con.execute("SELECT * FROM rooms WHERE id=?", (int(p[2]),)).fetchone())
                res = self.sync_room_tenant(b, dict(full, status=full["status"] if full["status"] != "Trống" else "Đang thuê"))
                if not res or res.get("error"):
                    raise auth.AuthError((res or {}).get("error") or "Phòng chưa có SĐT khách hợp lệ")
                return self.send_json(res)
            if act == "reset":
                return self.send_json({"setup_token": auth.reset_tenant(b, r["code"])})
            if act == "rotate-qr":  # đổi mã QR phòng: mã cũ trên bill hết hiệu lực
                with _lock, conn(b) as con:
                    con.execute("UPDATE rooms SET qr_salt=? WHERE id=?", (uuid.uuid4().hex[:8], int(p[2])))
                    row = dict(con.execute("SELECT * FROM rooms WHERE id=?", (int(p[2]),)).fetchone())
                return self.send_json({"access_token": room_token(b, row)})
            if act == "end":  # khách trả phòng: ngắt tài khoản nhưng giữ lịch sử hóa đơn đã ở
                t = date.today()
                auth.end_tenant(b, r["code"], t.year * 100 + t.month)
                return self.send_json({"ok": True})
            return self.send_json({"error": "action?"}, 400)
        if p == ["api", "bills", "publish"]:  # gửi bill cho khách qua app
            self.need("payments")
            ids = [int(x) for x in self.body_json().get("ids") or []]
            now = datetime.now().strftime("%Y-%m-%d %H:%M")
            with _lock, conn(b) as con:
                for i in ids:
                    con.execute("UPDATE bills SET published_at=? WHERE id=?", (now, i))
            return self.send_json({"ok": True, "published_at": now, "count": len(ids)})
        if len(p) == 4 and p[:2] == ["api", "rooms"] and p[3] in ("lock", "unlock"):  # chủ / quản lý chốt hoặc hủy chốt
            self.need("rooms")
            if p[3] == "lock":
                return self.send_json(self.lock_room(b, int(p[2]), self.body_json().get("note"), by_owner=True))
            return self.send_json(self.unlock_room(b, int(p[2]), by_owner=True))
        if len(p) == 4 and p[:2] == ["api", "rooms"] and p[3] == "share-sales":
            self.need("rooms")
            rid = int(p[2])
            ids = [int(x) for x in self.body_json().get("contact_ids") or []]
            with _lock, conn(b) as con:
                r = con.execute("SELECT listing FROM rooms WHERE id=?", (rid,)).fetchone()
                if not r:
                    return self.send_json({"error": "Không có phòng"}, 404)
                if not r["listing"]:  # đang ẩn -> chuyển sang chỉ Sales được gửi mới thấy
                    con.execute("UPDATE rooms SET listing='shared' WHERE id=?", (rid,))
            return self.send_json({"sent": auth.share_room(b, rid, self.user["id"], ids)})
        if p == ["api", "members"]:
            self.need("members")
            d = self.body_json()
            auth.add_member(b, d.get("username"), d.get("role") or "viewer")
            return self.send_json(auth.members(b))
        if p == ["api", "members", "create"]:  # chủ trọ tạo tài khoản mới cho quản lý / nhân viên
            self.need("members")
            d = self.body_json()
            auth.create_member(b, self.user["id"], d.get("username"), d.get("name"), d.get("password"), d.get("role") or "manager")
            return self.send_json(auth.members(b))
        if p == ["api", "sales-shares"]:
            self.need("members")
            auth.share_with_sales(b, self.body_json().get("username"))
            return self.send_json(auth.sales_shares(b))
        if p == ["api", "import-excel"]:
            self.need(*auth.CAP_KEYS)  # chỉ người có toàn quyền
            import import_excel  # cần openpyxl
            data = self.body_bytes(limit=50 * 1024 * 1024)
            tmp = os.path.join(DATA, f"_import_{b}.xlsm")
            with open(tmp, "wb") as f:
                f.write(data)
            try:
                with _lock:
                    msg = import_excel.do_import(tmp, b, replace=(q.get("replace") or ["0"])[0] == "1")
            finally:
                os.remove(tmp)
            return self.send_json({"message": msg})
        with _lock, conn(b) as con:
            if len(p) == 4 and p[:2] == ["api", "rooms"] and p[3] == "images":
                self.need("rooms")
                rid = int(p[2])
                if not con.execute("SELECT 1 FROM rooms WHERE id=?", (rid,)).fetchone():
                    return self.send_json({"error": "Phòng không tồn tại"}, 404)
                ctype = (self.headers.get("Content-Type") or "image/jpeg").split(";")[0]
                ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}.get(ctype)
                if not ext:
                    return self.send_json({"error": "Chỉ nhận ảnh JPG/PNG/WEBP/GIF"}, 400)
                data = self.body_bytes()
                name = f"r{rid}_{uuid.uuid4().hex[:12]}{ext}"
                with open(os.path.join(img_dir(b), name), "wb") as f:
                    f.write(data)
                mx = con.execute("SELECT COALESCE(MAX(sort),0) FROM images WHERE room_id=?", (rid,)).fetchone()[0]
                cur = con.execute("INSERT INTO images(room_id,filename,sort) VALUES(?,?,?)", (rid, name, mx + 1))
                return self.send_json(dict(con.execute("SELECT * FROM images WHERE id=?", (cur.lastrowid,)).fetchone()))
            if len(p) == 3 and p[:2] == ["api", "create-period"]:
                self.need("bills")
                return self.send_json(create_period(con, int(p[2])))
            if len(p) == 2 and p[0] == "api" and p[1] in TABLES and p[1] != "images":
                t = p[1]
                data = clean(t, self.body_json())
                if not data:
                    return self.send_json({"error": "Thiếu dữ liệu"}, 400)
                if t == "bills":
                    self.need("bills")
                elif t == "rooms":
                    self.need("rooms", *(["prices"] if any(_norm(data.get(k)) for k in ROOM_PRICE_FIELDS) else []))
                else:
                    self.need(field_cap(t, ""))
                cur = con.execute(f"INSERT INTO {t}({','.join(data)}) VALUES({','.join('?' * len(data))})", list(data.values()))
                if t == "rooms":  # phòng mới có SĐT khách -> tự tạo / gắn tài khoản app
                    con.commit()
                    row = dict(con.execute("SELECT * FROM rooms WHERE id=?", (cur.lastrowid,)).fetchone())
                    return self.send_json(dict(row, _tenant=self.sync_room_tenant(b, row)))
                if t == "contracts":
                    con.execute("UPDATE contracts SET created_by=? WHERE id=?", (self.user["username"], cur.lastrowid))
                    if data.get("end_date"):  # hợp đồng mới -> ngày ra của phòng = ngày hết hạn hợp đồng
                        con.execute("UPDATE rooms SET move_out=?, lease_status='' WHERE code=?", (data["end_date"], data["room_code"]))
                return self.send_json(dict(con.execute(f"SELECT * FROM {t} WHERE id=?", (cur.lastrowid,)).fetchone()))
        self.send_json({"error": "not found"}, 404)

    # ---------- AI ----------
    def read_images_json(self):
        """Body JSON: {"images": [{"type": "image/jpeg", "data": "<base64>"}, ...]}"""
        d = json.loads(self.body_bytes(limit=25 * 1024 * 1024).decode("utf-8") or "{}")
        out = []
        for im in (d.get("images") or [])[:4]:
            out.append((base64.b64decode(im.get("data") or ""), im.get("type") or "image/jpeg"))
        if not out:
            raise ValueError("Chưa có ảnh")
        return out

    def ai_routes(self, p, q):
        if p == ["api", "ai", "key"]:  # chỉ chủ hệ thống (tài khoản đầu tiên) đặt key dùng chung
            if not auth.is_system_owner(self.user["id"]):
                raise PermissionError("Chỉ chủ hệ thống (tài khoản đăng ký đầu tiên) mới đặt được API key")
            ai.save_key(self.body_json().get("api_key"))
            return self.send_json(ai.status())
        b = self.building(q)
        if len(p) == 4 and p[:3] == ["api", "ai", "meter"]:
            self.need("readings")
            bid = int(p[3])
            ctype = (self.headers.get("Content-Type") or "image/jpeg").split(";")[0]
            img = self.body_bytes()
            with conn(b) as con:
                bill = con.execute("SELECT * FROM bills WHERE id=?", (bid,)).fetchone()
                if not bill:
                    return self.send_json({"error": "Không tìm thấy dòng thu"}, 404)
                prev = con.execute("SELECT old_idx,new_idx,manual_kwh FROM bills WHERE room_code=? AND period<? "
                                   "ORDER BY period DESC LIMIT 1", (bill["room_code"], bill["period"])).fetchone()
                room = con.execute("SELECT meter_serial FROM rooms WHERE code=?", (bill["room_code"],)).fetchone()
            prev_kwh = None
            if prev:
                prev_kwh = (prev["new_idx"] - prev["old_idx"]) if prev["new_idx"] is not None and prev["old_idx"] is not None else prev["manual_kwh"]
            # lưu ảnh làm bằng chứng trước khi gọi AI (để vẫn còn ảnh nếu AI lỗi)
            ext = {"image/png": ".png", "image/webp": ".webp"}.get(ctype, ".jpg")
            name = f"meter_{bid}_{uuid.uuid4().hex[:10]}{ext}"
            with open(os.path.join(img_dir(b), name), "wb") as f:
                f.write(img)
            with _lock, conn(b) as con:
                con.execute("UPDATE bills SET meter_photo=? WHERE id=?", (name, bid))
            try:
                r = ai.read_meter(img, ctype, bill["room_code"], bill["old_idx"], prev_kwh)
            except ai.AIError as e:
                return self.send_json({"error": str(e), "photo": name}, 502)
            warn = []
            if not r["is_meter"]:
                warn.append("Ảnh có vẻ không phải đồng hồ điện.")
            if r["readable"] and bill["old_idx"] is not None and r["reading"] < bill["old_idx"]:
                warn.append(f"Số đọc được nhỏ hơn chỉ số kỳ trước ({int(bill['old_idx'])}).")
            if r["readable"] and bill["old_idx"] is not None and prev_kwh and r["reading"] - bill["old_idx"] > max(3 * prev_kwh, prev_kwh + 300):
                warn.append(f"Mức dùng cao bất thường so với tháng trước ({int(prev_kwh)} kWh).")
            ser = re.sub(r"\W", "", r.get("serial") or "")
            known = re.sub(r"\W", "", (room["meter_serial"] if room else "") or "")
            if ser and known and ser != known:
                warn.append(f"Số seri đồng hồ trên ảnh ({r['serial']}) khác seri đã lưu của phòng ({room['meter_serial']}) – có thể chụp nhầm phòng.")
            if r["confidence"] == "thap":
                warn.append("AI không chắc chắn – hãy xem ảnh và kiểm tra lại số.")
            return self.send_json(dict(r, photo=name, warnings=warn, known_serial=room["meter_serial"] if room else ""))
        if p == ["api", "ai", "idcard"]:
            self.need("rooms")
            try:
                return self.send_json(ai.read_id_card(self.read_images_json()))
            except ai.AIError as e:
                return self.send_json({"error": str(e)}, 502)
        self.send_json({"error": "not found"}, 404)

    # ---------- PUT ----------
    def do_PUT(self):
        self.run(self._put)

    def _put(self, p, q):
        b = self.building(q)
        if len(p) == 3 and p[:2] == ["api", "members"]:
            self.need("members")
            d = self.body_json()
            auth.update_member(b, int(p[2]), d.get("role"), d.get("caps"))
            return self.send_json(auth.members(b))
        with _lock, conn(b) as con:
            if p == ["api", "settings"]:
                cur = get_settings(con)
                new = self.body_json()
                diff = [k for k, v in new.items() if json.dumps(v, ensure_ascii=False, sort_keys=True) != json.dumps(cur.get(k), ensure_ascii=False, sort_keys=True)]
                self.need(*sorted({SETTING_CAP.get(k, "settings") for k in diff}))
                for k in diff:
                    con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(new[k], ensure_ascii=False)))
                return self.send_json(get_settings(con))
            if len(p) == 3 and p[0] == "api" and p[1] in TABLES:
                t, rid = p[1], int(p[2])
                old = con.execute(f"SELECT * FROM {t} WHERE id=?", (rid,)).fetchone()
                if not old:
                    return self.send_json({"error": "Không tìm thấy"}, 404)
                data = clean(t, self.body_json())
                data = {k: data[k] for k in changed_fields(dict(old), data)}  # chỉ ghi & xét quyền trường thực sự đổi
                self.need_fields(t, data)
                if t == "rooms" and "code" in data:
                    for tb in ("bills", "extras", "expenses"):
                        con.execute(f"UPDATE {tb} SET room_code=? WHERE room_code=?", (data["code"], old["code"]))
                    auth.rename_room(b, old["code"], data["code"])
                if data:
                    con.execute(f"UPDATE {t} SET {','.join(k + '=?' for k in data)} WHERE id=?", [*data.values(), rid])
                if t == "rooms" and data.get("listing") and not old["listing"] and old["lock_at"]:
                    # chủ mở lại phòng cho Sales (lần trống mới) -> xóa trạng thái chốt cũ
                    con.execute("UPDATE rooms SET lock_by=NULL, lock_by_name='', lock_at='', lock_note='' WHERE id=?", (rid,))
                row = dict(con.execute(f"SELECT * FROM {t} WHERE id=?", (rid,)).fetchone())
                if t == "rooms" and {"phone", "status", "tenant", "move_in"} & set(data):
                    # đổi SĐT / trạng thái -> tự tạo, gắn hoặc ngắt tài khoản app của khách
                    row["_tenant"] = self.sync_room_tenant(b, row)
                return self.send_json(row)
        self.send_json({"error": "not found"}, 404)

    # ---------- DELETE ----------
    def do_DELETE(self):
        self.run(self._delete)

    def _delete(self, p, q):
        if len(p) == 3 and p[:2] == ["api", "sales-contacts"]:
            auth.delete_contact(self.user["id"], int(p[2]))
            return self.send_json(auth.contacts(self.user["id"]))
        b = self.building(q)
        if len(p) == 3 and p[:2] == ["api", "invites"]:
            self.need("members")
            auth.revoke_invite(b, int(p[2]))
            return self.send_json(auth.list_invites(b))
        if len(p) == 3 and p[:2] == ["api", "sales-shares"]:
            self.need("members")
            auth.unshare_sales(b, int(p[2]))
            return self.send_json(auth.sales_shares(b))
        if len(p) == 3 and p[:2] == ["api", "members"]:
            if int(p[2]) != self.user["id"]:  # tự rời tòa thì không cần quyền
                self.need("members")
            auth.remove_member(b, int(p[2]))
            return self.send_json({"ok": True})
        with _lock, conn(b) as con:
            if len(p) == 3 and p[0] == "api" and p[1] in TABLES:
                t, rid = p[1], int(p[2])
                self.need({"rooms": "settings", "bills": "bills", "images": "rooms", "contracts": "rooms"}.get(t) or field_cap(t, ""))
                files = []
                if t == "images":
                    files = [r["filename"] for r in con.execute("SELECT filename FROM images WHERE id=?", (rid,))]
                if t == "rooms":
                    files = [r["filename"] for r in con.execute("SELECT filename FROM images WHERE room_id=?", (rid,))]
                    con.execute("DELETE FROM images WHERE room_id=?", (rid,))
                con.execute(f"DELETE FROM {t} WHERE id=?", (rid,))
                for f in files:
                    try:
                        os.remove(os.path.join(img_dir(b), f))
                    except OSError:
                        pass
                return self.send_json({"ok": True})
        self.send_json({"error": "not found"}, 404)


def auto_publish_once(now=None):
    """Gửi tự động qua app các bill đã nhập đủ chỉ số (chưa gửi) của phòng có tài khoản khách, khi đã tới giờ hẹn trong ngày."""
    now = now or datetime.now()
    cur, stamp, total = now.year * 100 + now.month, now.strftime("%Y-%m-%d %H:%M"), 0
    for b in all_building_codes():
        with _lock, conn(b) as con:
            s = get_settings(con)
            if not s.get("auto_publish", True) or now.hour < int(s.get("auto_publish_hour") or 20):
                continue
            active = {l["room_code"] for l in auth.tenant_links_building(b) if l["active"]}
            if not active:
                continue
            ready = rows(con, "SELECT id, room_code FROM bills WHERE published_at='' AND period<=? "
                              "AND (new_idx IS NOT NULL OR manual_kwh>0)", (cur,))
            for r in ready:
                if r["room_code"] in active:
                    con.execute("UPDATE bills SET published_at=? WHERE id=?", (stamp, r["id"]))
                    total += 1
    return total


def auto_publish_loop(stop):
    while True:  # chạy ngay khi mở app, sau đó 10 phút / lần
        try:
            n = auto_publish_once()
            if n:
                print(f"[{datetime.now():%d/%m %H:%M}] Tự động gửi {n} bill qua app cho khách")
        except Exception as e:  # noqa – không để lỗi làm dừng server
            print("Lỗi gửi bill tự động:", e)
        if stop.wait(600):
            break


def quote_name(s):
    from urllib.parse import quote
    return quote(s, safe="")


def main():
    global LAN_MODE
    if "--reset-password" in sys.argv:  # python server.py --reset-password <tên đăng nhập> <mật khẩu mới>
        i = sys.argv.index("--reset-password")
        auth.reset_password(sys.argv[i + 1], sys.argv[i + 2])
        return print("Đã đặt lại mật khẩu cho", sys.argv[i + 1])
    if "--grant" in sys.argv:  # python server.py --grant <mã tòa> <tên đăng nhập> [admin|manager|viewer]
        i = sys.argv.index("--grant")
        b, uname = sys.argv[i + 1], sys.argv[i + 2]
        role = sys.argv[i + 3] if len(sys.argv) > i + 3 else "admin"
        con = auth.udb()
        u = con.execute("SELECT id FROM users WHERE username=?", (uname.lower(),)).fetchone()
        con.close()
        if not u:
            return print("Không có tài khoản", uname)
        auth.grant(b, u["id"], role)
        return print(f"Đã cấp quyền {role} tòa {b} cho {uname}")
    migrate_legacy()
    for code in all_building_codes():  # nâng cấp CSDL các tòa lên cấu trúc mới
        with conn(code) as con:
            ensure_schema(con)
    threading.Thread(target=auto_publish_loop, args=(threading.Event(),), daemon=True).start()
    LAN_MODE = "--lan" in sys.argv
    host = "0.0.0.0" if LAN_MODE else "127.0.0.1"
    srv = ThreadingHTTPServer((host, PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"Quản lý nhà trọ đang chạy: {url}")
    if LAN_MODE:
        for u in lan_urls():
            print(f"Điện thoại cùng Wi-Fi mở: {u}")
    if auth.user_count() == 0:
        print("Chưa có tài khoản nào: mở app và bấm Đăng ký. Tài khoản đầu tiên sẽ là chủ trọ của các tòa hiện có.")
    print("Đóng cửa sổ này (hoặc Ctrl+C) để tắt.")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
