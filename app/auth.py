"""Tài khoản, phiên đăng nhập và phân quyền theo tòa nhà.

Lưu ở data/users.db (dùng chung cho mọi tòa). Dữ liệu từng tòa vẫn ở data/buildings/<mã>/.
Mỗi tài khoản chỉ thấy các tòa mình là thành viên. Vai trò:
  admin   = chủ trọ: toàn quyền, chia sẻ & phân quyền
  manager = quản lý: nhập chỉ số, thu tiền, phòng/khách, thu thêm, chi phí (không sửa giá, bill, STK)
  viewer  = chỉ xem
Admin có thể bật/tắt từng quyền cho từng thành viên (ghi đè mặc định của vai trò).
"""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
USERS_DB = os.path.join(DATA, "users.db")
SESSION_DAYS = 30
USERNAME_RE = re.compile(r"^[a-z0-9._@\-]{3,40}$")

CAPS = [
    ("readings", "Nhập chỉ số điện"),
    ("payments", "Đánh dấu đã thu tiền"),
    ("bills", "Sửa bill & tạo kỳ (tiền phòng, số người/xe, đơn giá trong bill, thêm/xóa dòng)"),
    ("prices", "Sửa giá (giá phòng, phí DV, cọc, đơn giá điện nước)"),
    ("rooms", "Sửa phòng, khách thuê, hình ảnh"),
    ("extras", "Thu thêm / giảm trừ"),
    ("expenses", "Chi phí"),
    ("bank", "Thông tin ngân hàng / số tài khoản"),
    ("settings", "Cài đặt khác, xóa phòng, nhập Excel, sao lưu"),
    ("members", "Chia sẻ & phân quyền thành viên"),
]
CAP_KEYS = [c for c, _ in CAPS]
ROLES = {
    "admin": set(CAP_KEYS),
    "manager": {"readings", "payments", "rooms", "extras", "expenses"},
    "viewer": set(),
}
ROLE_LABEL = {"admin": "Chủ trọ (admin)", "manager": "Quản lý", "viewer": "Chỉ xem"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
  pw_hash TEXT NOT NULL, salt TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  building TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL, perms TEXT,
  PRIMARY KEY (building, user_id)
);
CREATE TABLE IF NOT EXISTS sales_shares (
  building TEXT NOT NULL, user_id INTEGER NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (building, user_id)
);
-- lời mời xem / nhận chuyển nhượng tòa nhà (link + QR)
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, building TEXT NOT NULL,
  role TEXT NOT NULL, scope TEXT, transfer INTEGER DEFAULT 0, created_by INTEGER NOT NULL,
  created TEXT DEFAULT CURRENT_TIMESTAMP, expires REAL NOT NULL, used_by INTEGER, used_at TEXT
);
-- danh bạ Sales của từng chủ trọ (có thể chỉ có SĐT, hoặc gắn với tài khoản Sales)
CREATE TABLE IF NOT EXISTS sales_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, name TEXT DEFAULT '',
  phone TEXT DEFAULT '', user_id INTEGER, note TEXT DEFAULT '', created TEXT DEFAULT CURRENT_TIMESTAMP
);
-- tài khoản khách thuê gắn với phòng; since/until_period = khoảng kỳ khách được xem hóa đơn
CREATE TABLE IF NOT EXISTS tenant_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, building TEXT NOT NULL, room_code TEXT NOT NULL,
  since_period INTEGER NOT NULL, until_period INTEGER, active INTEGER DEFAULT 1,
  created_by INTEGER, created TEXT DEFAULT CURRENT_TIMESTAMP
);
-- mã QR / link để khách đặt mật khẩu lần đầu (hoặc khi quên)
CREATE TABLE IF NOT EXISTS setup_tokens (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires REAL NOT NULL, used INTEGER DEFAULT 0
);
-- phòng đã gửi cho liên hệ Sales nào
CREATE TABLE IF NOT EXISTS room_shares (
  building TEXT NOT NULL, room_id INTEGER NOT NULL, contact_id INTEGER NOT NULL,
  shared_by INTEGER, created TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (building, room_id, contact_id)
);
"""
# Loại tài khoản: owner = chủ trọ (tự đăng ký), staff = tài khoản chủ trọ tạo cho quản lý/nhân viên,
# sales = môi giới (tự đăng ký) – chỉ xem các phòng được công khai / chia sẻ riêng.
KINDS = {"owner": "Chủ trọ", "staff": "Nhân viên / quản lý", "sales": "Sales", "tenant": "Khách thuê"}


class AuthError(Exception):
    pass


def udb():
    os.makedirs(DATA, exist_ok=True)
    con = sqlite3.connect(USERS_DB, timeout=10)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    have = {r[1] for r in con.execute("PRAGMA table_info(users)")}
    for col, decl in (("kind", "TEXT DEFAULT 'owner'"), ("phone", "TEXT DEFAULT ''"), ("created_by", "INTEGER"),
                      ("pw_set", "INTEGER DEFAULT 1")):  # pw_set=0: khách chưa quét QR đặt mật khẩu
        if col not in have:
            con.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
    if "scope" not in {r[1] for r in con.execute("PRAGMA table_info(memberships)")}:
        # scope (JSON) giới hạn dữ liệu được xem: {"from_period": 202611, "pii": false}
        con.execute("ALTER TABLE memberships ADD COLUMN scope TEXT")
    return con


def norm_phone(p):
    d = re.sub(r"\D", "", p or "")
    if d.startswith("84") and len(d) == 11:
        d = "0" + d[2:]
    if len(d) == 9 and not d.startswith("0"):
        d = "0" + d
    return d


PHONE_RE = re.compile(r"^0\d{9}$")  # SĐT Việt Nam 10 số


def login_name(s):
    """Tên đăng nhập = SĐT (chuẩn hóa: bỏ dấu cách/chấm, +84 -> 0). Tài khoản cũ dạng chữ vẫn dùng được."""
    s = (s or "").strip().lower()
    return norm_phone(s) if re.fullmatch(r"[\d\s.+\-()]+", s or "x") else s


def _scope(s):
    try:
        return json.loads(s) if s else {}
    except ValueError:
        return {}


def _hash(pw, salt):
    return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), 200_000).hex()


def _th(tok):
    return hashlib.sha256(tok.encode()).hexdigest()


def public(u):
    return {"id": u["id"], "username": u["username"], "name": u["name"] or u["username"],
            "kind": u["kind"] or "owner", "phone": u["phone"] or ""}


def user_count():
    con = udb()
    try:
        return con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    finally:
        con.close()


def register(username, name, password, kind="owner", phone="", created_by=None):
    """Đăng ký bằng số điện thoại: SĐT chính là tên đăng nhập."""
    username = norm_phone(username or phone)
    if not PHONE_RE.match(username):
        raise AuthError("Nhập số điện thoại Việt Nam 10 số (vd 0912345678) – SĐT là tên đăng nhập")
    phone = username
    if len(password or "") < 6:
        raise AuthError("Mật khẩu tối thiểu 6 ký tự")
    if kind not in KINDS:
        raise AuthError("Loại tài khoản không hợp lệ")
    salt = secrets.token_hex(16)
    con = udb()
    try:
        cur = con.execute("INSERT INTO users(username,name,pw_hash,salt,kind,phone,created_by) VALUES(?,?,?,?,?,?,?)",
                          (username, (name or "").strip(), _hash(password, salt), salt, kind, (phone or "").strip(), created_by))
        con.commit()
        return public(con.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone())
    except sqlite3.IntegrityError:
        ex = con.execute("SELECT kind, pw_set FROM users WHERE username=?", (username,)).fetchone()
        if ex and ex["kind"] == "tenant" and not ex["pw_set"]:
            raise AuthError("SĐT này đã được chủ trọ tạo tài khoản – hãy dùng link / mã QR chủ trọ gửi để kích hoạt")
        raise AuthError("SĐT này đã có tài khoản – chọn Đăng nhập")
    finally:
        con.close()


def login(username, password):
    con = udb()
    try:
        u = con.execute("SELECT * FROM users WHERE username=?", (login_name(username),)).fetchone()
        if u and not u["pw_set"]:
            raise AuthError("Tài khoản chưa kích hoạt – dùng link / mã QR chủ trọ gửi để đặt mật khẩu")
        if not u or not secrets.compare_digest(_hash(password or "", u["salt"]), u["pw_hash"]):
            time.sleep(1.2)  # làm chậm dò mật khẩu
            raise AuthError("Sai số điện thoại hoặc mật khẩu")
        tok = secrets.token_urlsafe(32)
        now = time.time()
        con.execute("DELETE FROM sessions WHERE expires<?", (now,))
        con.execute("INSERT INTO sessions VALUES(?,?,?)", (_th(tok), u["id"], now + SESSION_DAYS * 86400))
        con.commit()
        return tok, public(u)
    finally:
        con.close()


def user_by_token(tok):
    if not tok:
        return None
    con = udb()
    try:
        u = con.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?",
                        (_th(tok), time.time())).fetchone()
        return public(u) if u else None
    finally:
        con.close()


def logout(tok):
    con = udb()
    try:
        con.execute("DELETE FROM sessions WHERE token_hash=?", (_th(tok or ""),))
        con.commit()
    finally:
        con.close()


def change_password(uid, old, new, keep_token=None):
    if len(new or "") < 6:
        raise AuthError("Mật khẩu mới tối thiểu 6 ký tự")
    con = udb()
    try:
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not secrets.compare_digest(_hash(old or "", u["salt"]), u["pw_hash"]):
            raise AuthError("Mật khẩu hiện tại không đúng")
        salt = secrets.token_hex(16)
        con.execute("UPDATE users SET pw_hash=?, salt=? WHERE id=?", (_hash(new, salt), salt, uid))
        # đăng xuất các thiết bị khác
        con.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (uid, _th(keep_token or "")))
        con.commit()
    finally:
        con.close()


def reset_password(username, new):
    """Dùng từ dòng lệnh khi quên mật khẩu: python server.py --reset-password <tên> <mật khẩu mới>"""
    if len(new or "") < 6:
        raise AuthError("Mật khẩu tối thiểu 6 ký tự")
    con = udb()
    try:
        salt = secrets.token_hex(16)
        username = login_name(username)
        n = con.execute("UPDATE users SET pw_hash=?, salt=?, pw_set=1 WHERE username=?", (_hash(new, salt), salt, username)).rowcount
        if not n:
            raise AuthError("Không có tài khoản " + username)
        con.execute("DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)", (username,))
        con.commit()
    finally:
        con.close()


# ---------------- quyền theo tòa ----------------
def caps_of(role, perms_json):
    if perms_json:
        try:
            return {c for c in json.loads(perms_json) if c in CAP_KEYS}
        except ValueError:
            pass
    return set(ROLES.get(role, set()))


def claim_orphans(codes):
    """Tòa chưa có thành viên nào (dữ liệu cũ / nhập bằng dòng lệnh) -> giao cho tài khoản đầu tiên làm admin."""
    con = udb()
    try:
        first = con.execute("SELECT MIN(id) FROM users WHERE kind='owner'").fetchone()[0]
        if not first:
            return
        for c in codes:
            if not con.execute("SELECT 1 FROM memberships WHERE building=?", (c,)).fetchone():
                con.execute("INSERT INTO memberships(building,user_id,role) VALUES(?,?,'admin')", (c, first))
        con.commit()
    finally:
        con.close()


def is_system_owner(uid):
    """Tài khoản chủ trọ đăng ký đầu tiên = chủ hệ thống (đặt API key AI dùng chung)."""
    con = udb()
    try:
        return con.execute("SELECT MIN(id) FROM users WHERE kind='owner'").fetchone()[0] == uid
    finally:
        con.close()


def membership(building, uid):
    con = udb()
    try:
        m = con.execute("SELECT role, perms, scope FROM memberships WHERE building=? AND user_id=?", (building, uid)).fetchone()
        return (m["role"], caps_of(m["role"], m["perms"]), _scope(m["scope"])) if m else None
    finally:
        con.close()


def my_buildings(uid):
    con = udb()
    try:
        return {r["building"]: {"role": r["role"], "caps": sorted(caps_of(r["role"], r["perms"])), "scope": _scope(r["scope"])}
                for r in con.execute("SELECT * FROM memberships WHERE user_id=?", (uid,))}
    finally:
        con.close()


def grant(building, uid, role="admin", scope=None):
    con = udb()
    try:
        con.execute("INSERT OR REPLACE INTO memberships(building,user_id,role,perms,scope) VALUES(?,?,?,NULL,?)",
                    (building, uid, role, json.dumps(scope) if scope else None))
        con.commit()
    finally:
        con.close()


def members(building):
    con = udb()
    try:
        out = []
        for r in con.execute("SELECT m.*, u.username, u.name FROM memberships m JOIN users u ON u.id=m.user_id "
                             "WHERE building=? ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.username",
                             (building,)):
            out.append({"user_id": r["user_id"], "username": r["username"], "name": r["name"] or r["username"],
                        "role": r["role"], "custom": bool(r["perms"]), "caps": sorted(caps_of(r["role"], r["perms"])),
                        "scope": _scope(r["scope"])})
        return out
    finally:
        con.close()


def _admins(con, building):
    return con.execute("SELECT COUNT(*) FROM memberships WHERE building=? AND role='admin'", (building,)).fetchone()[0]


def add_member(building, username, role):
    if role not in ROLES:
        raise AuthError("Vai trò không hợp lệ")
    con = udb()
    try:
        u = con.execute("SELECT id, kind FROM users WHERE username=?", (login_name(username),)).fetchone()
        if not u:
            raise AuthError("SĐT này chưa có tài khoản. Dùng “Tạo tài khoản mới”, hoặc nhờ người đó tự đăng ký.")
        if u["kind"] == "sales":
            raise AuthError("Đây là tài khoản Sales – hãy chia sẻ phòng ở tab Gửi Sales thay vì thêm làm thành viên.")
        if con.execute("SELECT 1 FROM memberships WHERE building=? AND user_id=?", (building, u["id"])).fetchone():
            raise AuthError("Người này đã là thành viên")
        con.execute("INSERT INTO memberships(building,user_id,role) VALUES(?,?,?)", (building, u["id"], role))
        con.commit()
    finally:
        con.close()


def update_member(building, uid, role, caps=None):
    if role not in ROLES:
        raise AuthError("Vai trò không hợp lệ")
    con = udb()
    try:
        cur = con.execute("SELECT role FROM memberships WHERE building=? AND user_id=?", (building, uid)).fetchone()
        if not cur:
            raise AuthError("Không phải thành viên")
        if cur["role"] == "admin" and role != "admin" and _admins(con, building) <= 1:
            raise AuthError("Tòa phải còn ít nhất 1 chủ trọ (admin)")
        perms = None
        if caps is not None and role != "admin":
            caps = sorted(c for c in caps if c in CAP_KEYS)
            perms = None if set(caps) == ROLES[role] else json.dumps(caps)
        con.execute("UPDATE memberships SET role=?, perms=? WHERE building=? AND user_id=?", (role, perms, building, uid))
        con.commit()
    finally:
        con.close()


def create_member(building, creator_id, username, name, password, role):
    """Chủ trọ tạo luôn tài khoản cho quản lý/nhân viên (không cần người đó tự đăng ký)."""
    if role not in ROLES:
        raise AuthError("Vai trò không hợp lệ")
    phone = norm_phone(username)
    con = udb()
    try:
        ex = con.execute("SELECT * FROM users WHERE username=?", (phone,)).fetchone()
    finally:
        con.close()
    if ex:  # SĐT đã có tài khoản -> chỉ cần lưu vào tòa nhà
        if ex["kind"] == "sales":
            raise AuthError("SĐT này là tài khoản Sales – thêm vào Danh bạ Sales thay vì làm thành viên")
        grant(building, ex["id"], role)
        return dict(public(ex), existed=True)
    u = register(phone, name, password, kind="staff", created_by=creator_id)
    grant(building, u["id"], role)
    return dict(u, existed=False)


# ---------------- chia sẻ phòng cho Sales ----------------
def sales_shares(building):
    con = udb()
    try:
        return [{"user_id": r["id"], "username": r["username"], "name": r["name"] or r["username"], "phone": r["phone"] or ""}
                for r in con.execute("SELECT u.* FROM sales_shares s JOIN users u ON u.id=s.user_id WHERE s.building=? "
                                     "ORDER BY u.username", (building,))]
    finally:
        con.close()


def share_with_sales(building, username):
    con = udb()
    try:
        u = con.execute("SELECT id, kind FROM users WHERE username=?", (login_name(username),)).fetchone()
        if not u:
            raise AuthError("SĐT này chưa có tài khoản – Sales cần tự đăng ký (chọn loại Sales) trước.")
        if u["kind"] != "sales":
            raise AuthError("Tài khoản này không phải loại Sales.")
        con.execute("INSERT OR IGNORE INTO sales_shares(building,user_id) VALUES(?,?)", (building, u["id"]))
        con.commit()
    finally:
        con.close()


def unshare_sales(building, uid):
    con = udb()
    try:
        con.execute("DELETE FROM sales_shares WHERE building=? AND user_id=?", (building, uid))
        con.commit()
    finally:
        con.close()


def shared_buildings(uid):
    con = udb()
    try:
        return {r["building"] for r in con.execute("SELECT building FROM sales_shares WHERE user_id=?", (uid,))}
    finally:
        con.close()


def building_admins(building):
    con = udb()
    try:
        return [{"name": r["name"] or r["username"], "phone": r["phone"] or ""} for r in con.execute(
            "SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.building=? AND m.role='admin' ORDER BY u.id", (building,))]
    finally:
        con.close()


def remove_member(building, uid):
    con = udb()
    try:
        cur = con.execute("SELECT role FROM memberships WHERE building=? AND user_id=?", (building, uid)).fetchone()
        if cur and cur["role"] == "admin" and _admins(con, building) <= 1:
            raise AuthError("Không thể xóa chủ trọ (admin) cuối cùng")
        con.execute("DELETE FROM memberships WHERE building=? AND user_id=?", (building, uid))
        con.commit()
    finally:
        con.close()


# ---------------- chia sẻ / sang nhượng tòa nhà qua link hoặc QR ----------------
def create_invite(building, by_uid, role, scope=None, transfer=False, days=7):
    if role not in ROLES:
        raise AuthError("Vai trò không hợp lệ")
    tok = secrets.token_urlsafe(24)
    con = udb()
    try:
        con.execute("INSERT INTO invites(token_hash,building,role,scope,transfer,created_by,expires) VALUES(?,?,?,?,?,?,?)",
                    (_th(tok), building, role, json.dumps(scope) if scope else None, 1 if transfer else 0, by_uid,
                     time.time() + max(1, min(30, int(days or 7))) * 86400))
        con.commit()
        return tok
    finally:
        con.close()


def _invite_row(con, tok):
    r = con.execute("SELECT i.*, u.name AS by_name, u.username AS by_username FROM invites i JOIN users u ON u.id=i.created_by "
                    "WHERE token_hash=?", (_th(tok or ""),)).fetchone()
    if not r:
        raise AuthError("Link / mã QR không hợp lệ")
    if r["used_by"]:
        raise AuthError("Link này đã được dùng")
    if r["expires"] < time.time():
        raise AuthError("Link đã hết hạn – nhờ chủ tòa tạo link mới")
    return r


def invite_info(tok):
    con = udb()
    try:
        r = _invite_row(con, tok)
        return {"building": r["building"], "role": r["role"], "scope": _scope(r["scope"]), "transfer": bool(r["transfer"]),
                "by": r["by_name"] or r["by_username"], "expires": r["expires"]}
    finally:
        con.close()


def accept_invite(tok, uid):
    con = udb()
    try:
        r = _invite_row(con, tok)
        u = con.execute("SELECT kind FROM users WHERE id=?", (uid,)).fetchone()
        if u["kind"] == "sales":
            raise AuthError("Tài khoản Sales không nhận tòa nhà – dùng tài khoản chủ trọ")
        if r["created_by"] == uid:
            raise AuthError("Đây là link do chính bạn tạo – gửi cho tài khoản chủ khác")
        cur = con.execute("SELECT role FROM memberships WHERE building=? AND user_id=?", (r["building"], uid)).fetchone()
        if cur and cur["role"] == "admin" and r["role"] != "admin":
            raise AuthError("Bạn đã là chủ trọ của tòa này")
        con.execute("INSERT OR REPLACE INTO memberships(building,user_id,role,perms,scope) VALUES(?,?,?,NULL,?)",
                    (r["building"], uid, r["role"], r["scope"]))
        if r["transfer"]:  # sang nhượng: người tạo link rời tòa, người nhận làm chủ
            con.execute("DELETE FROM memberships WHERE building=? AND user_id=?", (r["building"], r["created_by"]))
            con.execute("DELETE FROM invites WHERE building=? AND used_by IS NULL AND id<>?", (r["building"], r["id"]))
        con.execute("UPDATE invites SET used_by=?, used_at=CURRENT_TIMESTAMP WHERE id=?", (uid, r["id"]))
        con.commit()
        return {"building": r["building"], "role": r["role"], "transfer": bool(r["transfer"])}
    finally:
        con.close()


def list_invites(building):
    con = udb()
    try:
        return [{"id": r["id"], "role": r["role"], "scope": _scope(r["scope"]), "transfer": bool(r["transfer"]),
                 "created": r["created"], "expires": r["expires"], "by": r["by_name"] or r["by_username"],
                 "used_by": r["used_name"], "used_at": r["used_at"]}
                for r in con.execute("SELECT i.*, a.name AS by_name, a.username AS by_username, b.username AS used_name "
                                     "FROM invites i JOIN users a ON a.id=i.created_by LEFT JOIN users b ON b.id=i.used_by "
                                     "WHERE i.building=? ORDER BY i.id DESC LIMIT 20", (building,))]
    finally:
        con.close()


def revoke_invite(building, iid):
    con = udb()
    try:
        con.execute("DELETE FROM invites WHERE building=? AND id=? AND used_by IS NULL", (building, iid))
        con.commit()
    finally:
        con.close()


# ---------------- danh bạ Sales & gửi phòng cho Sales ----------------
def _link_contact(con, phone, username):
    if username:
        u = con.execute("SELECT id, kind FROM users WHERE username=?", (username.strip().lower(),)).fetchone()
        if not u:
            raise AuthError(f"Không có tài khoản {username}")
        if u["kind"] != "sales":
            raise AuthError(f"{username} không phải tài khoản Sales")
        return u["id"]
    if phone:  # tự gắn nếu SĐT trùng tài khoản Sales đã đăng ký
        for u in con.execute("SELECT id, phone FROM users WHERE kind='sales'"):
            if norm_phone(u["phone"]) == phone:
                return u["id"]
    return None


def contacts(owner_id):
    con = udb()
    try:
        return [{"id": r["id"], "name": r["name"], "phone": r["phone"], "note": r["note"], "user_id": r["user_id"],
                 "username": r["username"] or ""}
                for r in con.execute("SELECT c.*, u.username FROM sales_contacts c LEFT JOIN users u ON u.id=c.user_id "
                                     "WHERE owner_id=? ORDER BY c.name, c.id", (owner_id,))]
    finally:
        con.close()


def add_contact(owner_id, name, phone, username="", note=""):
    phone = norm_phone(phone)
    if not phone and not username:
        raise AuthError("Nhập SĐT hoặc tên đăng nhập của Sales")
    con = udb()
    try:
        uid = _link_contact(con, phone, username)
        dup = con.execute("SELECT 1 FROM sales_contacts WHERE owner_id=? AND ((phone<>'' AND phone=?) OR (user_id IS NOT NULL AND user_id=?))",
                          (owner_id, phone, uid)).fetchone()
        if dup:
            raise AuthError("Sales này đã có trong danh bạ")
        if uid and not name:
            name = con.execute("SELECT name FROM users WHERE id=?", (uid,)).fetchone()["name"]
        con.execute("INSERT INTO sales_contacts(owner_id,name,phone,user_id,note) VALUES(?,?,?,?,?)",
                    (owner_id, (name or "").strip(), phone, uid, (note or "").strip()))
        con.commit()
    finally:
        con.close()


def delete_contact(owner_id, cid):
    con = udb()
    try:
        con.execute("DELETE FROM room_shares WHERE contact_id IN (SELECT id FROM sales_contacts WHERE id=? AND owner_id=?)", (cid, owner_id))
        con.execute("DELETE FROM sales_contacts WHERE id=? AND owner_id=?", (cid, owner_id))
        con.commit()
    finally:
        con.close()


def share_room(building, room_id, owner_id, contact_ids):
    con = udb()
    try:
        own = {r["id"]: r for r in con.execute("SELECT * FROM sales_contacts WHERE owner_id=?", (owner_id,))}
        picked = [own[c] for c in contact_ids if c in own]
        for c in picked:
            con.execute("INSERT OR REPLACE INTO room_shares(building,room_id,contact_id,shared_by) VALUES(?,?,?,?)",
                        (building, room_id, c["id"], owner_id))
        con.commit()
        return [{"id": c["id"], "name": c["name"], "phone": c["phone"], "has_account": bool(c["user_id"])} for c in picked]
    finally:
        con.close()


# ---------------- khách thuê ----------------
def tenant_links_building(building):
    """Tài khoản khách của các phòng trong tòa (để giao diện chủ trọ biết phòng nào gửi bill qua app được)."""
    con = udb()
    try:
        return [{"id": r["id"], "room_code": r["room_code"], "username": r["username"], "name": r["name"], "active": bool(r["active"]),
                 "since_period": r["since_period"], "until_period": r["until_period"], "has_password": bool(r["pw_set"])}
                for r in con.execute("SELECT l.*, u.username, u.name, u.pw_set FROM tenant_links l JOIN users u ON u.id=l.user_id "
                                     "WHERE l.building=? ORDER BY l.id DESC", (building,))]
    finally:
        con.close()


def tenant_links_of(uid):
    con = udb()
    try:
        return [dict(r) for r in con.execute("SELECT * FROM tenant_links WHERE user_id=? ORDER BY active DESC, id DESC", (uid,))]
    finally:
        con.close()


def _setup_token(con, uid, days=14):
    tok = secrets.token_urlsafe(18)
    con.execute("DELETE FROM setup_tokens WHERE user_id=?", (uid,))
    con.execute("INSERT INTO setup_tokens(token_hash,user_id,expires) VALUES(?,?,?)", (_th(tok), uid, time.time() + days * 86400))
    return tok


def link_tenant(building, room_code, phone, name, since_period, by_uid):
    """Tạo (hoặc dùng lại) tài khoản khách theo SĐT và gắn vào phòng. Trả về tài khoản + mã đặt mật khẩu (nếu cần)."""
    phone = norm_phone(phone)
    if len(phone) < 9:
        raise AuthError("Phòng chưa có SĐT khách hợp lệ – nhập SĐT ở form phòng trước")
    con = udb()
    try:
        # SĐT đã có tài khoản (kể cả chủ trọ / sales thuê phòng) -> chỉ gắn phòng vào tài khoản đó
        u = con.execute("SELECT * FROM users WHERE username=?", (phone,)).fetchone()
        created = False
        if not u:
            salt = secrets.token_hex(16)
            cur = con.execute("INSERT INTO users(username,name,pw_hash,salt,kind,phone,created_by,pw_set) VALUES(?,?,?,?,?,?,?,0)",
                              (phone, (name or "").strip(), _hash(secrets.token_hex(16), salt), salt, "tenant", phone, by_uid))
            u = con.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
            created = True
        # phòng chỉ có 1 tài khoản khách đang hoạt động: ngắt tài khoản cũ (giữ lịch sử hóa đơn của họ)
        con.execute("UPDATE tenant_links SET active=0, until_period=COALESCE(until_period, ?) WHERE building=? AND room_code=? AND active=1 AND user_id<>?",
                    (since_period - 1 if since_period % 100 != 1 else since_period - 89, building, room_code, u["id"]))
        new_link = not con.execute("SELECT 1 FROM tenant_links WHERE building=? AND room_code=? AND user_id=? AND active=1",
                                   (building, room_code, u["id"])).fetchone()
        if new_link:
            con.execute("INSERT INTO tenant_links(user_id,building,room_code,since_period,created_by) VALUES(?,?,?,?,?)",
                        (u["id"], building, room_code, since_period, by_uid))
        # chỉ sinh mã QR khi vừa tạo tài khoản (lưu phòng lại không làm mã đã gửi khách mất hiệu lực)
        tok = _setup_token(con, u["id"]) if created else None
        con.commit()
        return {"username": u["username"], "created": created, "new_link": new_link, "setup_token": tok, "kind": u["kind"],
                "activated": bool(u["pw_set"])}
    finally:
        con.close()


def reset_tenant(building, room_code):
    """Tạo lại mã QR đặt mật khẩu cho khách đang ở phòng (khách quên mật khẩu / đổi máy)."""
    con = udb()
    try:
        r = con.execute("SELECT l.user_id, u.kind FROM tenant_links l JOIN users u ON u.id=l.user_id "
                        "WHERE l.building=? AND l.room_code=? AND l.active=1", (building, room_code)).fetchone()
        if not r:
            raise AuthError("Phòng chưa có tài khoản khách")
        if r["kind"] != "tenant":  # tài khoản người dùng tự đăng ký: chủ trọ không được đặt lại mật khẩu hộ
            raise AuthError("SĐT này là tài khoản người dùng tự đăng ký – họ tự đổi / lấy lại mật khẩu, chủ trọ không tạo mã QR được")
        tok = _setup_token(con, r["user_id"])
        con.commit()
        return tok
    finally:
        con.close()


def claim_room(building, room_code, uid, since_period):
    """Khách quét mã QR phòng (trên bill / chủ gửi): gắn phòng vào tài khoản. Cho phép nhiều người ở chung."""
    con = udb()
    try:
        ex = con.execute("SELECT id FROM tenant_links WHERE building=? AND room_code=? AND user_id=? AND active=1",
                         (building, room_code, uid)).fetchone()
        if not ex:
            con.execute("INSERT INTO tenant_links(user_id,building,room_code,since_period) VALUES(?,?,?,?)",
                        (uid, building, room_code, since_period))
            con.commit()
        return not ex
    finally:
        con.close()


def activate_with_claim(phone, password, building, room_code, room_phone):
    """Tài khoản khách chủ đã tạo sẵn (chưa kích hoạt): cho tự đặt mật khẩu nếu khách cầm mã QR đúng phòng của mình."""
    if len(password or "") < 6:
        raise AuthError("Mật khẩu tối thiểu 6 ký tự")
    phone = norm_phone(phone)
    con = udb()
    try:
        u = con.execute("SELECT * FROM users WHERE username=?", (phone,)).fetchone()
        if not u or u["kind"] != "tenant" or u["pw_set"]:
            return None
        linked = con.execute("SELECT 1 FROM tenant_links WHERE user_id=? AND building=? AND room_code=? AND active=1",
                             (u["id"], building, room_code)).fetchone()
        if not linked and norm_phone(room_phone) != phone:
            raise AuthError("SĐT này đã được chủ trọ tạo tài khoản cho phòng khác – dùng mã QR kích hoạt chủ trọ gửi")
        salt = secrets.token_hex(16)
        con.execute("UPDATE users SET pw_hash=?, salt=?, pw_set=1 WHERE id=?", (_hash(password, salt), salt, u["id"]))
        con.execute("DELETE FROM setup_tokens WHERE user_id=?", (u["id"],))
        con.commit()
    finally:
        con.close()
    return login(phone, password)


def rename_room(building, old_code, new_code):
    con = udb()
    try:
        con.execute("UPDATE tenant_links SET room_code=? WHERE building=? AND room_code=?", (new_code, building, old_code))
        con.commit()
    finally:
        con.close()


def end_tenant(building, room_code, until_period):
    con = udb()
    try:
        n = con.execute("UPDATE tenant_links SET active=0, until_period=? WHERE building=? AND room_code=? AND active=1",
                        (until_period, building, room_code)).rowcount
        con.commit()
        return n
    finally:
        con.close()


def setup_info(tok):
    con = udb()
    try:
        r = con.execute("SELECT u.username, u.name FROM setup_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.used=0 AND t.expires>?",
                        (_th(tok or ""), time.time())).fetchone()
        if not r:
            raise AuthError("Mã QR không hợp lệ hoặc đã hết hạn – nhờ chủ trọ tạo mã mới")
        return {"username": r["username"], "name": r["name"]}
    finally:
        con.close()


def setup_password(tok, password):
    if len(password or "") < 6:
        raise AuthError("Mật khẩu tối thiểu 6 ký tự")
    con = udb()
    try:
        r = con.execute("SELECT user_id FROM setup_tokens WHERE token_hash=? AND used=0 AND expires>?", (_th(tok or ""), time.time())).fetchone()
        if not r:
            raise AuthError("Mã QR không hợp lệ hoặc đã hết hạn – nhờ chủ trọ tạo mã mới")
        salt = secrets.token_hex(16)
        con.execute("UPDATE users SET pw_hash=?, salt=?, pw_set=1 WHERE id=?", (_hash(password, salt), salt, r["user_id"]))
        con.execute("UPDATE setup_tokens SET used=1 WHERE token_hash=?", (_th(tok),))
        con.execute("DELETE FROM sessions WHERE user_id=?", (r["user_id"],))
        new = secrets.token_urlsafe(32)
        con.execute("INSERT INTO sessions VALUES(?,?,?)", (_th(new), r["user_id"], time.time() + SESSION_DAYS * 86400))
        con.commit()
        return new, public(con.execute("SELECT * FROM users WHERE id=?", (r["user_id"],)).fetchone())
    finally:
        con.close()


def room_shares_for(uid):
    """{(tòa, id phòng): thời điểm gửi gần nhất} – phòng chủ trọ đã gửi cho Sales này (khớp theo tài khoản hoặc SĐT)."""
    con = udb()
    try:
        me = con.execute("SELECT phone FROM users WHERE id=?", (uid,)).fetchone()
        ph = norm_phone(me["phone"] if me else "")
        ids = [r["id"] for r in con.execute("SELECT id FROM sales_contacts WHERE user_id=? OR (user_id IS NULL AND ?<>'' AND phone=?)",
                                            (uid, ph, ph))]
        if not ids:
            return {}
        q = ("SELECT building, room_id, MAX(created) AS t FROM room_shares WHERE contact_id IN (" + ",".join("?" * len(ids))
             + ") GROUP BY building, room_id")
        return {(r["building"], r["room_id"]): r["t"] for r in con.execute(q, ids)}
    finally:
        con.close()
