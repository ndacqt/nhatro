"""Tạo DỮ LIỆU ẢO cho 1 kỳ (mặc định: tháng liền trước kỳ sớm nhất) để có số so sánh.

Mọi dòng tạo ra đều có ghi chú bắt đầu bằng [DEMO] để dễ nhận biết / xóa.
Chạy:  python seed_demo.py S01                 -> tạo T10 nếu kỳ sớm nhất là T11
       python seed_demo.py S01 --period 202610
       python seed_demo.py S01 --remove        -> xóa toàn bộ dữ liệu [DEMO] của tòa S01
       python seed_demo.py S01 --leases        -> gán ngày ra (hết hạn HĐ) ảo cho phòng đang thuê để thử nhắc tái ký
       python seed_demo.py S01 --remove-leases -> trả ngày vào/ra về như cũ
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

TAG = "[DEMO]"


def prev_period(p):
    y, m = divmod(p, 100)
    return (y - 1) * 100 + 12 if m == 1 else p - 1


def seed(b, period=None):
    con = server.db(b)
    s = server.get_settings(con)
    first = con.execute("SELECT MIN(period) FROM bills").fetchone()[0]
    if not first:
        return "Tòa này chưa có kỳ nào để làm mẫu."
    period = period or prev_period(first)
    if con.execute("SELECT 1 FROM bills WHERE period=?", (period,)).fetchone():
        return f"Kỳ {period} đã có dữ liệu – không tạo đè."
    tpl_p = con.execute("SELECT MIN(period) FROM bills WHERE period>?", (period,)).fetchone()[0]
    tpl = server.rows(con, "SELECT * FROM bills WHERE period=?", (tpl_p,))
    rooms = {r["code"]: r for r in server.rows(con, "SELECT * FROM rooms")}
    rnd = random.Random(f"{b}-{period}")
    y, m = divmod(period, 100)
    next_start = f"{y + (m == 12)}-{(m % 12) + 1:02d}-01"
    n, skipped, total_kwh, total_people = 0, [], 0, 0
    for t in tpl:
        r = rooms.get(t["room_code"], {})
        if (r.get("move_in") or "") >= next_start:  # khách vào sau kỳ này -> kỳ này phòng chưa thuê
            skipped.append(t["room_code"])
            continue
        kwh_tpl = (t["new_idx"] - t["old_idx"]) if t["old_idx"] is not None and t["new_idx"] is not None else 0
        kwh = max(40, round((kwh_tpl if kwh_tpl > 10 else rnd.randint(90, 220)) * rnd.uniform(0.8, 1.15)))
        new_idx = t["old_idx"] if t["old_idx"] is not None else None
        old_idx = new_idx - kwh if new_idx is not None and new_idx - kwh >= 0 else None
        manual = None if old_idx is not None else kwh
        paid_day = f"{y + (m == 12)}-{(m % 12) + 1:02d}-{rnd.randint(1, 6):02d}"
        con.execute(
            "INSERT INTO bills(period,room_code,old_idx,new_idx,manual_kwh,people,rent,service_fee,vehicles,"
            "elec_price,water_price,parking_price,paid,paid_date,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
            (period, t["room_code"], old_idx, new_idx if old_idx is not None else None, manual, t["people"], t["rent"],
             t["service_fee"], t["vehicles"], t["elec_price"], t["water_price"], t["parking_price"], paid_day,
             f"{TAG} dữ liệu ảo để so sánh"))
        total_kwh += kwh
        total_people += t["people"] or 0
        n += 1
    # vài khoản thu thêm
    codes = [t["room_code"] for t in tpl if t["room_code"] not in skipped]
    for code, typ, content, amt in [(rnd.choice(codes), "Giặt sấy", "4 lần × 20.000", 80000),
                                    (rnd.choice(codes), "Phí trễ hạn", "Trễ 3 ngày", 50000)]:
        con.execute("INSERT INTO extras(date,period,room_code,type,content,amount,note) VALUES(?,?,?,?,?,?,?)",
                    (f"{y}-{m:02d}-20", period, code, typ, content, amt, TAG))
    # chi phí: cố định giống kỳ mẫu, điện/nước theo hóa đơn "ảo"
    for e in server.rows(con, "SELECT * FROM expenses WHERE period=?", (tpl_p,)):
        if e["auto"] == "KWH":
            amt = round(total_kwh * s.get("elec_cost", 3412) * rnd.uniform(0.97, 1.05), -3)
        elif e["auto"] == "NGUOI":
            amt = round(total_people * s.get("water_cost", 100800) * rnd.uniform(0.9, 1.05), -3)
        else:
            amt = e["amount"]
        con.execute("INSERT INTO expenses(date,period,category,content,amount,room_code,method,note,auto,estimated)"
                    " VALUES(?,?,?,?,?,?,?,?,?,0)",
                    (f"{y}-{m:02d}-28", period, e["category"], e["content"], amt, e["room_code"], "Chuyển khoản",
                     f"{TAG} hóa đơn ảo", e["auto"]))
    con.execute("INSERT INTO expenses(date,period,category,content,amount,method,note) VALUES(?,?,?,?,?,?,?)",
                (f"{y}-{m:02d}-12", period, "Sửa chữa", "Thay vòi sen, bóng đèn hành lang", 650000, "Tiền mặt", TAG))
    con.commit()
    con.close()
    return (f"Tòa {b}: tạo kỳ {period} gồm {n} phòng ({total_kwh} kWh)"
            + (f", bỏ qua {', '.join(skipped)} (khách vào sau)" if skipped else "") + ".")


LEASE_OFFSETS = [-4, 3, 9, 16, 24, 38, 55, 75, 100, 130, 160, 190, 220, 260, 300, 340]  # ngày so với hôm nay


def _lease_file(b):
    return os.path.join(server.DATA, f"demo_leases_{b}.json")


def seed_leases(b):
    """Gán ngày ra (hết hạn HĐ) ảo cho các phòng đang thuê: có phòng quá hạn, sắp hết hạn trong vài ngày, vài tuần, vài tháng.
    Lưu giá trị cũ ra file để gỡ lại được."""
    import datetime as dt
    import json
    if os.path.exists(_lease_file(b)):
        return f"Tòa {b} đã có dữ liệu ngày ra ảo – chạy --remove-leases trước nếu muốn tạo lại."
    con = server.db(b)
    server.ensure_schema(con)
    rooms = server.rows(con, "SELECT id, code, move_in, move_out, lease_status FROM rooms WHERE status='Đang thuê' ORDER BY sort, code")
    today = dt.date.today()
    backup, lines = {}, []
    for i, r in enumerate(rooms):
        out = today + dt.timedelta(days=LEASE_OFFSETS[i % len(LEASE_OFFSETS)] + 7 * (i // len(LEASE_OFFSETS)))
        mi = r["move_in"] or (out - dt.timedelta(days=365)).isoformat()
        backup[r["id"]] = {k: r[k] for k in ("move_in", "move_out", "lease_status")}
        con.execute("UPDATE rooms SET move_in=?, move_out=?, lease_status='' WHERE id=?", (mi, out.isoformat(), r["id"]))
        lines.append(f"{r['code']}: ra {out.strftime('%d/%m/%Y')} ({(out - today).days:+d} ngày)")
    con.commit()
    con.close()
    with open(_lease_file(b), "w", encoding="utf-8") as f:
        json.dump(backup, f)
    return f"Tòa {b}: gán ngày ra ảo cho {len(rooms)} phòng.\n  " + "\n  ".join(lines[:8]) + ("\n  …" if len(lines) > 8 else "")


def remove_leases(b):
    import json
    if not os.path.exists(_lease_file(b)):
        return f"Tòa {b} không có dữ liệu ngày ra ảo."
    with open(_lease_file(b), encoding="utf-8") as f:
        backup = json.load(f)
    con = server.db(b)
    for rid, v in backup.items():
        con.execute("UPDATE rooms SET move_in=?, move_out=?, lease_status=? WHERE id=?", (v["move_in"], v["move_out"], v["lease_status"], int(rid)))
    con.commit()
    con.close()
    os.remove(_lease_file(b))
    return f"Tòa {b}: đã trả ngày vào/ra về như trước khi tạo dữ liệu ảo ({len(backup)} phòng)."


def remove(b):
    con = server.db(b)
    k = [con.execute(f"DELETE FROM {t} WHERE note LIKE ?", (TAG + "%",)).rowcount for t in ("bills", "extras", "expenses")]
    con.commit()
    con.close()
    return f"Đã xóa dữ liệu ảo tòa {b}: {k[0]} dòng thu, {k[1]} thu thêm, {k[2]} chi phí."


if __name__ == "__main__":
    b = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "S01"
    if "--leases" in sys.argv:
        print(seed_leases(b))
    elif "--remove-leases" in sys.argv:
        print(remove_leases(b))
    elif "--remove" in sys.argv:
        print(remove(b))
    else:
        per = int(sys.argv[sys.argv.index("--period") + 1]) if "--period" in sys.argv else None
        print(seed(b, per))
