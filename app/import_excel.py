"""Nhập dữ liệu từ file Excel QuanLyThuChi_NhaTro*.xlsm vào 1 tòa nhà của app.

Chạy:  python import_excel.py "..\\QuanLyThuChi_NhaTro.xlsm"                 (mã tòa lấy theo 'Tên nhà trọ' trong Cai dat)
       python import_excel.py "..\\QuanLyThuChi_NhaTro_S02.xlsm" --building S02
       thêm --replace để XÓA phòng/thu/chi hiện có của tòa đó trước khi nhập.
Cũng dùng được từ giao diện: Cài đặt → Nhập từ Excel.
"""
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402


def iso(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    return str(v or "")


def num(v, default=0):
    try:
        return float(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


def is_formula(v):
    return isinstance(v, str) and v.startswith("=")


def building_code_of(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    name = wb["Cai dat"]["B4"].value or "S01"
    return re.sub(r"[^A-Za-z0-9_\-]", "", str(name)) or "S01"


def do_import(path, building, replace=False):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=False)
    server.init_db(building)
    con = server.db(building)
    if replace:
        for t in ("bills", "extras", "expenses", "rooms"):
            con.execute(f"DELETE FROM {t}")

    # ---- Cài đặt ----
    cd = wb["Cai dat"]
    s = server.get_settings(con)
    s.update({
        "house_name": cd["B4"].value or s["house_name"], "address": cd["B5"].value or "",
        "phone": str(cd["B6"].value or ""), "bank_name": cd["B7"].value or "",
        "account_no": str(cd["B9"].value or ""), "account_name": cd["B10"].value or "",
        "due_day": int(num(cd["B11"].value, 5)), "elec_price": num(cd["B13"].value),
        "water_price": num(cd["B14"].value), "service_fee": num(cd["B15"].value),
        "parking_price": num(cd["B16"].value), "elec_cost": num(cd["B18"].value),
        "water_cost": num(cd["B19"].value),
    })
    banks = [[cd.cell(r, 14).value, str(cd.cell(r, 15).value)] for r in range(4, 31) if cd.cell(r, 14).value]
    if banks:
        s["banks"] = banks
    s["bank_bin"] = dict(s["banks"]).get(s["bank_name"], "")
    cats = []
    for r in range(4, 24):
        name = cd.cell(r, 4).value
        if name:
            cats.append({"name": name, "group": cd.cell(r, 5).value or "Khác", "fixed": num(cd.cell(r, 6).value),
                         "estimate": (cd.cell(r, 7).value or "").upper(), "note": cd.cell(r, 8).value or ""})
    if cats:
        s["expense_categories"] = cats
    ex = [cd.cell(r, 10).value for r in range(4, 24) if cd.cell(r, 10).value]
    if ex:
        s["extra_types"] = ex
    for k, v in s.items():
        con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v, ensure_ascii=False)))

    # ---- Phòng ----
    n_room = 0
    for i, r in enumerate(wb["Phong"].iter_rows(min_row=5, values_only=True)):
        if not r[0]:
            continue
        con.execute(
            "INSERT INTO rooms(code,status,tenant,phone,move_in,price,people,vehicles,service_fee,deposit,note,sort)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET status=excluded.status,"
            " tenant=excluded.tenant, phone=excluded.phone, move_in=excluded.move_in, price=excluded.price,"
            " people=excluded.people, vehicles=excluded.vehicles, service_fee=excluded.service_fee,"
            " deposit=excluded.deposit, note=excluded.note",
            (str(r[0]).strip(), r[1] or "Trống", r[2] or "", str(r[3] or ""), iso(r[4]), num(r[5]),
             int(num(r[6])), int(num(r[7])), num(r[8]), num(r[9]), r[10] or "", i))
        n_room += 1

    # ---- Thu tháng ----
    n_bill = 0
    for r in wb["Thu thang"].iter_rows(min_row=5, values_only=True):
        if not r[0] or not r[1] or not isinstance(r[0], (int, float)):
            continue
        idx = lambda v: None if v in (None, "") or is_formula(v) else num(v)  # noqa: E731
        con.execute(
            "INSERT OR REPLACE INTO bills(period,room_code,old_idx,new_idx,manual_kwh,people,rent,service_fee,vehicles,"
            "elec_price,water_price,parking_price,paid,paid_date,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (int(r[0]), str(r[1]).strip(), idx(r[2]), idx(r[3]), idx(r[4]),
             int(num(r[7])), num(r[9]), num(r[10]), int(num(r[11])),
             s["elec_price"], s["water_price"], s["parking_price"],
             1 if r[17] else 0, iso(r[18]), r[23] or ""))
        n_bill += 1

    # ---- Thu thêm ----
    n_ex = 0
    for r in wb["Thu them"].iter_rows(min_row=5, values_only=True):
        if not r[2] or r[5] in (None, "") or is_formula(r[5]):
            continue
        per = int(r[1]) if r[1] else server.period_of(iso(r[0]))
        if not per:
            continue
        con.execute("INSERT INTO extras(date,period,room_code,type,content,amount,note) VALUES(?,?,?,?,?,?,?)",
                    (iso(r[0]), per, str(r[2]).strip(), r[3] or "", r[4] or "", num(r[5]), r[6] or ""))
        n_ex += 1

    # ---- Chi phí ----
    n_cp = 0
    est_map = {c["name"]: c["estimate"] for c in s["expense_categories"]}
    for r in wb["Chi phi"].iter_rows(min_row=5, values_only=True):
        if not r[2] or r[4] in (None, ""):
            continue
        per = int(r[1]) if r[1] else server.period_of(iso(r[0]))
        if not per:
            continue
        note = r[7] or ""
        # gắn nhãn auto để "Tạo kỳ" không thêm trùng; ô là công thức tạm tính -> app tự tính (estimated=1)
        auto = est_map.get(r[2]) or ("fixed" if note.lower().startswith("tu dong") else "")
        estimated = 1 if is_formula(r[4]) and auto in ("KWH", "NGUOI") else 0
        con.execute("INSERT INTO expenses(date,period,category,content,amount,room_code,method,note,auto,estimated)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (iso(r[0]), per, r[2], r[3] or "", 0 if is_formula(r[4]) else num(r[4]), str(r[5] or ""),
                     r[6] or "", note, auto, estimated))
        n_cp += 1

    con.commit()
    con.close()
    return f"Tòa {building}: {n_room} phòng, {n_bill} dòng thu tháng, {n_ex} thu thêm, {n_cp} chi phí."


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = args[0] if args else os.path.join(os.path.dirname(server.BASE), "QuanLyThuChi_NhaTro.xlsm")
    b = None
    if "--building" in sys.argv:
        b = sys.argv[sys.argv.index("--building") + 1]
        args = [a for a in args if a != b]
        path = args[0] if args else path
    b = b or building_code_of(path)
    print(do_import(path, b, replace="--replace" in sys.argv))


if __name__ == "__main__":
    main()
