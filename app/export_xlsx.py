"""Xuất dữ liệu quản lý ra file Excel (.xlsx) – cho chủ trọ là công ty cần nộp / lưu sổ sách.

Tính toán giống hệt giao diện (app.js: calc / expAmount / report) để số liệu khớp với màn hình.
"""
import io
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

MONEY = '#,##0'
HEAD_FILL = PatternFill("solid", fgColor="0F766E")
HEAD_FONT = Font(bold=True, color="FFFFFF")
TOTAL_FILL = PatternFill("solid", fgColor="E3F2EF")
THIN = Side(style="thin", color="D9DEDB")
GROUPS = ["Nhà", "Điện", "Nước", "Dịch vụ", "Xe", "Khác"]


def n0(v):
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def plabel(p):
    return f"T{p % 100}/{p // 100}"


def calc(b, extras):
    has = b["old_idx"] is not None and b["new_idx"] is not None
    kwh = (n0(b["new_idx"]) - n0(b["old_idx"])) if has else n0(b["manual_kwh"])
    elec = kwh * n0(b["elec_price"])
    water = n0(b["people"]) * n0(b["water_price"])
    parking = n0(b["vehicles"]) * n0(b["parking_price"])
    extra = sum(n0(e["amount"]) for e in extras if e["period"] == b["period"] and e["room_code"] == b["room_code"])
    total = elec + water + n0(b["rent"]) + n0(b["service_fee"]) + parking + extra
    return {"kwh": kwh, "elec": elec, "water": water, "parking": parking, "extra": extra, "total": total}


def exp_amount(e, d):
    if not e["estimated"]:
        return n0(e["amount"])
    bs = [b for b in d["bills"] if b["period"] == e["period"]]
    s = d["settings"]
    if e["auto"] == "KWH":
        return round(sum(calc(b, d["extras"])["kwh"] for b in bs) * n0(s.get("elec_cost")))
    if e["auto"] == "NGUOI":
        return round(sum(n0(b["people"]) for b in bs) * n0(s.get("water_cost")))
    return n0(e["amount"])


def group_of(cat, s):
    for c in s.get("expense_categories") or []:
        if c.get("name") == cat:
            return c.get("group") or "Khác"
    return "Khác"


def summary_rows(d):
    periods = sorted({b["period"] for b in d["bills"]} | {e["period"] for e in d["expenses"]})
    out = []
    for p in periods:
        bs = [b for b in d["bills"] if b["period"] == p]
        cs = [calc(b, d["extras"]) for b in bs]
        thu = {"Nhà": sum(n0(b["rent"]) for b in bs), "Điện": sum(c["elec"] for c in cs), "Nước": sum(c["water"] for c in cs),
               "Dịch vụ": sum(n0(b["service_fee"]) for b in bs), "Xe": sum(c["parking"] for c in cs), "Thu thêm": sum(c["extra"] for c in cs)}
        paid = sum(c["total"] for b, c in zip(bs, cs) if b["paid"])
        unpaid = sum(c["total"] for b, c in zip(bs, cs) if not b["paid"])
        chi = {g: 0.0 for g in GROUPS}
        for e in d["expenses"]:
            if e["period"] == p:
                chi[group_of(e["category"], d["settings"])] = chi.get(group_of(e["category"], d["settings"]), 0) + exp_amount(e, d)
        tthu, tchi = sum(thu.values()), sum(chi.values())
        out.append([plabel(p), len(bs), thu["Nhà"], thu["Điện"], thu["Nước"], thu["Dịch vụ"], thu["Xe"], thu["Thu thêm"], tthu, paid, unpaid,
                    chi["Nhà"], chi["Điện"], chi["Nước"], chi["Dịch vụ"], chi["Xe"] + chi["Khác"], tchi, tthu - tchi,
                    (tthu - tchi) / tthu if tthu else 0, sum(c["kwh"] for c in cs)])
    return out


SUMMARY_HEAD = ["Kỳ", "Số phòng", "Tiền phòng", "Điện", "Nước", "Dịch vụ", "Xe", "Thu thêm", "TỔNG THU", "Đã thu", "Chưa thu",
                "Chi nhà", "Chi điện", "Chi nước", "Chi dịch vụ", "Chi khác", "TỔNG CHI", "LÃI", "Biên lãi", "kWh"]


def write_table(ws, head, rows, money_cols=(), pct_cols=(), total=False, start_row=1, widths=None):
    for j, h in enumerate(head, 1):
        c = ws.cell(start_row, j, h)
        c.fill, c.font = HEAD_FILL, HEAD_FONT
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for i, r in enumerate(rows, start_row + 1):
        for j, v in enumerate(r, 1):
            c = ws.cell(i, j, v)
            c.border = Border(bottom=THIN)
            if j in money_cols:
                c.number_format = MONEY
            if j in pct_cols:
                c.number_format = "0%"
    last = start_row + len(rows)
    if total and rows:
        tr = last + 1
        ws.cell(tr, 1, "TỔNG").font = Font(bold=True)
        for j in money_cols:
            col = get_column_letter(j)
            c = ws.cell(tr, j, f"=SUM({col}{start_row + 1}:{col}{last})")  # công thức để Excel tự cộng lại khi sửa
            c.number_format, c.font = MONEY, Font(bold=True)
        for j in range(1, len(head) + 1):
            ws.cell(tr, j).fill = TOTAL_FILL
    ws.freeze_panes = ws.cell(start_row + 1, 2)
    if rows:
        ws.auto_filter.ref = f"A{start_row}:{get_column_letter(len(head))}{last}"
    ws.row_dimensions[start_row].height = 32
    for j, h in enumerate(head, 1):
        w = (widths or {}).get(j) or max(10, min(40, max([len(str(h))] + [len(f"{r[j - 1]:,.0f}" if isinstance(r[j - 1], float) else str(r[j - 1] or "")) for r in rows[:300]]) + 2))
        ws.column_dimensions[get_column_letter(j)].width = w


def building_sheets(wb, code, d, prefix=""):
    s, ex = d["settings"], d["extras"]
    rooms = {r["code"]: r for r in d["rooms"]}
    t = lambda name: (prefix + name)[:31]  # noqa: E731  (Excel giới hạn tên sheet 31 ký tự)

    ws = wb.create_sheet(t("Tổng hợp"))
    write_table(ws, SUMMARY_HEAD, summary_rows(d), money_cols=set(range(3, 19)) | {20}, pct_cols={19}, total=True)

    ws = wb.create_sheet(t("Thu tháng"))
    rows = []
    for b in sorted(d["bills"], key=lambda x: (x["period"], x["room_code"])):
        c = calc(b, ex)
        rows.append([plabel(b["period"]), b["room_code"], (rooms.get(b["room_code"]) or {}).get("tenant", ""), b["old_idx"], b["new_idx"],
                     c["kwh"], n0(b["elec_price"]), c["elec"], b["people"], c["water"], n0(b["rent"]), n0(b["service_fee"]),
                     b["vehicles"], c["parking"], c["extra"], c["total"], "Đã thu" if b["paid"] else "Chưa thu", b["paid_date"] or "", b["note"] or ""])
    write_table(ws, ["Kỳ", "Phòng", "Khách thuê", "Chỉ số cũ", "Chỉ số mới", "kWh", "Đơn giá điện", "Tiền điện", "Số người", "Tiền nước",
                     "Tiền phòng", "Phí DV", "Số xe", "Tiền xe", "Thu thêm", "TỔNG", "Trạng thái", "Ngày thu", "Ghi chú"],
                rows, money_cols={6, 7, 8, 10, 11, 12, 14, 15, 16}, total=True, widths={3: 26, 19: 30})

    ws = wb.create_sheet(t("Chi phí"))
    rows = [[plabel(e["period"]), e["date"], e["category"], group_of(e["category"], s), e["content"], exp_amount(e, d), e["room_code"],
             e["method"], "Tạm tính" if e["estimated"] else "", e["note"]] for e in sorted(d["expenses"], key=lambda x: (x["period"], x["date"] or ""))]
    write_table(ws, ["Kỳ", "Ngày", "Hạng mục", "Nhóm", "Nội dung", "Số tiền", "Phòng", "Hình thức", "Tạm tính", "Ghi chú"],
                rows, money_cols={6}, total=True, widths={5: 30, 10: 34})

    ws = wb.create_sheet(t("Thu thêm"))
    rows = [[plabel(e["period"]), e["date"], e["room_code"], e["type"], e["content"], n0(e["amount"]), e["note"]] for e in ex]
    write_table(ws, ["Kỳ", "Ngày", "Phòng", "Loại", "Nội dung", "Số tiền", "Ghi chú"], rows, money_cols={6}, total=True, widths={5: 30})

    ws = wb.create_sheet(t("Phòng"))
    pii = not d.get("scope") or d["scope"].get("pii")
    head = ["Phòng", "Trạng thái", "Khách thuê", "SĐT", "Ngày vào", "Ngày ra / hết hạn HĐ", "Giá phòng", "Số người", "Số xe", "Phí DV",
            "Tiền cọc", "Diện tích", "Tầng", "Hiển thị Sales"]
    if pii:
        head += ["Ngày sinh", "Giới tính", "Số CCCD", "Ngày cấp", "Nơi cấp", "Thường trú", "Quê quán"]
    rows = []
    for r in d["rooms"]:
        row = [r["code"], r["status"], r["tenant"], r["phone"], r["move_in"], r.get("move_out", ""), n0(r["price"]), r["people"], r["vehicles"],
               n0(r["service_fee"]), n0(r["deposit"]), r["area"] or "", r["floor"], {"public": "Công khai", "shared": "Gửi riêng"}.get(r.get("listing"), "Ẩn")]
        if pii:
            row += [r.get(k, "") for k in ("tenant_dob", "tenant_gender", "tenant_id_no", "tenant_id_date", "tenant_id_place", "tenant_address", "tenant_hometown")]
        rows.append(row)
    write_table(ws, head, rows, money_cols={7, 10, 11}, widths={3: 26})

    if d.get("contracts"):
        ws = wb.create_sheet(t("Hợp đồng"))
        rows = [[c["room_code"], c["tenant"], c["start_date"], c["end_date"], c["months"], n0(c["rent"]), n0(c["deposit"]), c["created"], c["created_by"]]
                for c in d["contracts"]]
        write_table(ws, ["Phòng", "Khách thuê", "Từ ngày", "Đến ngày", "Số tháng", "Giá thuê", "Tiền cọc", "Ngày lập", "Người lập"], rows, money_cols={6, 7})


def build(datasets, user_name):
    """datasets: [(mã tòa, dữ liệu dump_all)]. Nhiều tòa -> thêm sheet so sánh các tòa và tiền tố tên sheet."""
    wb = Workbook()
    info = wb.active
    info.title = "Thông tin"
    info["A1"] = "BÁO CÁO QUẢN LÝ NHÀ TRỌ"
    info["A1"].font = Font(bold=True, size=16, color="0F766E")
    info.append([])
    info.append(["Xuất lúc", datetime.now().strftime("%d/%m/%Y %H:%M")])
    info.append(["Người xuất", user_name])
    info.append([])
    info.append(["Mã tòa", "Tên", "Địa chỉ", "Số phòng", "Dữ liệu"])
    for c in info[6]:
        c.fill, c.font = HEAD_FILL, HEAD_FONT
    for code, d in datasets:
        sc = d.get("scope") or {}
        info.append([code, d["settings"].get("house_name"), d["settings"].get("address"), len(d["rooms"]),
                     f"từ {plabel(sc['from_period'])}" if sc.get("from_period") else "toàn bộ"])
    for col, w in zip("ABCDE", (12, 24, 40, 10, 16)):
        info.column_dimensions[col].width = w
    multi = len(datasets) > 1
    if multi:
        ws = wb.create_sheet("Các tòa")
        rows = []
        for code, d in datasets:
            for r in summary_rows(d):
                rows.append([code] + r)
        rows.sort(key=lambda x: (x[1][-4:], int(x[1][1:x[1].index("/")]), x[0]))
        write_table(ws, ["Tòa"] + SUMMARY_HEAD, rows, money_cols=set(range(4, 20)) | {21}, pct_cols={20}, total=True)
    for code, d in datasets:
        building_sheets(wb, code, d, prefix=f"{code} - " if multi else "")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
