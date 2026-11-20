"""Đóng gói app thành file .zip để cài sang máy khác – KHÔNG kèm dữ liệu.

Chạy:  python package.py          -> dist/QuanLyNhaTro_<ngày>.zip

Gói chỉ chứa mã nguồn + giao diện. Thư mục data/ (CSDL, ảnh, tài khoản, API key, khóa bí mật),
file Excel và __pycache__ đều bị loại bỏ, nên máy mới khởi động app sẽ là một hệ thống trống.
"""
import os
import zipfile
from datetime import date

APP = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(APP)
SKIP_DIRS = {"data", "__pycache__", "dist", ".claude"}
SKIP_EXT = {".pyc", ".xlsm", ".xlsx", ".xls", ".db", ".key"}


def main():
    out_dir = os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"QuanLyNhaTro_{date.today().isoformat()}.zip")
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for extra in ("README.md", ".gitignore"):
            p = os.path.join(ROOT, extra)
            if os.path.isfile(p):
                z.write(p, extra)
                n += 1
        for base, dirs, files in os.walk(APP):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in files:
                if os.path.splitext(f)[1].lower() in SKIP_EXT or f.startswith("~$"):
                    continue
                full = os.path.join(base, f)
                z.write(full, os.path.join("app", os.path.relpath(full, APP)))
                n += 1
    print(f"Đã đóng gói {n} file (không kèm dữ liệu): {out}")


if __name__ == "__main__":
    main()
