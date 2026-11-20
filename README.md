# Quản lý nhà trọ

Ứng dụng web quản lý dãy trọ / tòa nhà cho thuê, chạy trên máy tính của chủ trọ, dùng được trên điện thoại cùng Wi‑Fi. Thay thế file Excel `QuanLyThuChi_NhaTro.xlsm`: nhập chỉ số điện, tính tiền, xuất bill có mã QR chuyển khoản, theo dõi thu chi – và mở rộng thêm tài khoản cho quản lý, Sales (môi giới) và khách thuê.

- **Không cần cài thêm gì ngoài Python 3.10+** (máy chủ chỉ dùng thư viện chuẩn + SQLite).
- Hai thư viện tùy chọn: `openpyxl` (nhập / xuất Excel) và `anthropic` (AI đọc ảnh đồng hồ điện, căn cước).
- Mỗi tòa nhà một CSDL riêng; mọi dữ liệu nằm trong `app/data/` (không đưa lên Git).

---

## Mục lục

1. [Cài đặt và chạy](#1-cài-đặt-và-chạy)
2. [Vai trò & tài khoản](#2-vai-trò--tài-khoản)
3. [Tính năng cho chủ trọ](#3-tính-năng-cho-chủ-trọ)
4. [Sales (môi giới)](#4-sales-môi-giới)
5. [Khách thuê](#5-khách-thuê)
6. [AI đọc ảnh](#6-ai-đọc-ảnh-claude)
7. [Dữ liệu, sao lưu, đóng gói](#7-dữ-liệu-sao-lưu-đóng-gói)
8. [Lệnh dòng lệnh](#8-lệnh-dòng-lệnh)
9. [Cấu trúc mã nguồn](#9-cấu-trúc-mã-nguồn)
10. [Bảo mật & giới hạn](#10-bảo-mật--giới-hạn)

---

## 1. Cài đặt và chạy

### Yêu cầu
- Windows / macOS / Linux có **Python 3.10 trở lên** (`python --version`).
- Tùy chọn:
  ```bash
  python -m pip install openpyxl     # nhập / xuất Excel
  python -m pip install anthropic    # AI đọc ảnh đồng hồ điện, căn cước
  ```

### Chạy trên máy tính
- Windows: bấm đúp **`app/run.bat`**.
- Hoặc: `cd app` rồi `python server.py`

Trình duyệt tự mở **http://localhost:8686**. Đóng cửa sổ đen (hoặc Ctrl+C) để tắt app.

### Cho điện thoại cùng Wi‑Fi dùng
- Windows: bấm đúp **`app/run-dienthoai.bat`** (= `python server.py --lan`).
- Cửa sổ đen in địa chỉ dạng `http://192.168.x.x:8686`; trong app bấm **📱** (góc trên) để hiện mã QR cho điện thoại quét.
- Lần đầu Windows hỏi tường lửa → chọn **Allow access**. Mạng công ty có thể chặn thiết bị nói chuyện với nhau.
- Trên điện thoại: menu trình duyệt → **Thêm vào màn hình chính** để có biểu tượng như app.

### Lần đầu sử dụng
1. Mở app → **Đăng ký** bằng số điện thoại, chọn **Chủ trọ**. Tài khoản chủ trọ đầu tiên là *chủ hệ thống* (được nhập API key AI, sở hữu các tòa nhập từ dòng lệnh).
2. Chọn ô tòa nhà (góc trên trái) → **+ Thêm tòa nhà…**, hoặc **Cài đặt → Nhập từ Excel** để lấy dữ liệu từ file `QuanLyThuChi_NhaTro*.xlsm` cũ.
3. **Cài đặt**: tên nhà, địa chỉ, khu vực, ngân hàng + số tài khoản (để bill có mã QR VietQR), đơn giá điện / nước / dịch vụ / xe, thông tin Bên A cho hợp đồng.

> Nếu đặt file `QuanLyThuChi_NhaTro.xlsm` cạnh thư mục `app/`, lần chạy đầu `run.bat` tự nhập nó thành tòa nhà đầu tiên.

Cổng mặc định 8686; đổi bằng biến môi trường `PORT`.

---

## 2. Vai trò & tài khoản

**Số điện thoại là tên đăng nhập** của mọi tài khoản (nhập `0912 345 678`, `0912.345.678`, `+84912345678` đều được).

| Vai trò | Có tài khoản bằng cách | Thấy / làm được |
|---|---|---|
| **Chủ trọ** | Tự đăng ký (chọn Chủ trọ) | Toàn quyền các tòa của mình: phòng, thu chi, bill, hợp đồng, thành viên, Sales, chia sẻ / sang nhượng tòa |
| **Quản lý / Chỉ xem** (thành viên tòa) | Chủ trọ thêm theo SĐT ở **Cài đặt → Thành viên** (SĐT đã có tài khoản thì chỉ gắn vào tòa) | Theo quyền chủ cấp; mặc định *Quản lý*: nhập chỉ số, thu tiền, phòng / khách / ảnh, thu thêm, chi phí – không sửa giá, bill, số tài khoản, cài đặt |
| **Sales** | Tự đăng ký (chọn Sales) | Chỉ trang **Tìm phòng**: phòng trống / sắp trống chủ trọ công khai hoặc gửi riêng; không thấy khách thuê, hóa đơn, số tài khoản |
| **Khách thuê** | Tự đăng ký (chọn Khách thuê) rồi quét **mã QR phòng** in trên bill; hoặc chủ tạo tự động theo SĐT phòng và gửi mã QR kích hoạt | Hóa đơn phòng mình (tháng này + lịch sử), mã QR thanh toán, báo "đã chuyển khoản" |

### Phân quyền chi tiết (thành viên tòa)
Ở bảng Thành viên, chủ trọ tích / bỏ từng quyền cho từng người:
`Nhập chỉ số điện` · `Đánh dấu đã thu` · `Sửa bill & tạo kỳ` · `Sửa giá` · `Sửa phòng, khách, ảnh` · `Thu thêm` · `Chi phí` · `Ngân hàng / STK` · `Cài đặt khác` · `Chia sẻ & phân quyền`.
Máy chủ kiểm tra quyền ở **mọi thao tác** (chỉ tính những trường thực sự thay đổi), không chỉ ẩn nút trên giao diện.

### Chia sẻ / sang nhượng tòa nhà
**Cài đặt → Chia sẻ / sang nhượng tòa** tạo link + mã QR (dùng 1 lần, hạn 1–30 ngày):
- **Xem trước** (người mua / đối tác): chỉ xem, mặc định *doanh thu tháng gần nhất* + toàn bộ thông tin phòng, giá, chi phí; có thể chọn 3 / 6 / 12 tháng / toàn bộ; CCCD & hợp đồng khách chỉ kèm khi tích chọn.
- **Sang nhượng toàn quyền**: người nhận thành chủ trọ, người tạo link rời tòa.

---

## 3. Tính năng cho chủ trọ

| Tab | Chức năng |
|---|---|
| **Tổng quan** | Thu – chi – lãi theo khoản, so sánh với tháng trước (▲▼ %), so sánh các tòa, biểu đồ 12 tháng, nhắc hợp đồng sắp hết hạn, nút **⬇ Excel** |
| **Thu tháng** | Tạo kỳ mới (tự lấy chỉ số cũ, giá, số người, xe, chi phí cố định), nhập *Chỉ số mới* (Enter xuống phòng tiếp), **📷 chụp đồng hồ – AI đọc số**, *Chụp điện lần lượt*, cột kWh tháng trước + cảnh báo chênh lệch, tích đã thu |
| **Bill** | Phiếu thanh toán có **mã QR VietQR** (số tiền + nội dung CK điền sẵn) và **mã QR xem lịch sử hóa đơn** cho khách; tải PNG, in / PDF, gửi Zalo (copy ảnh + mở chat), gửi Zalo lần lượt cả kỳ, **📤 gửi bill qua app** |
| **Phòng** | Khách thuê, SĐT, ngày vào / **ngày ra (hết hạn HĐ)**, giá, cọc; **📷 chụp CCCD – AI tự điền**; thông tin cho Sales (diện tích, tầng, tiện ích, mô tả); kho ảnh; **hợp đồng thuê tự động** (in / PDF / Word); **tài khoản app của khách** + mã QR phòng |
| **Gửi Sales** | Tin đăng tự soạn từ giá + dịch vụ + tiện ích, ảnh tổng hợp (poster), tải ảnh .zip, chế độ hiển thị cho Sales (Ẩn / Công khai / Gửi riêng), **📒 Danh bạ Sales** + **📣 Gửi cho danh bạ** |
| **Chi phí / Thu thêm** | Sổ chi (cố định tự thêm theo kỳ; điện / nước tạm tính theo kWh / số người đến khi có hóa đơn thật) và thu thêm / giảm trừ |
| **Cài đặt** | Thông tin nhà, khu vực, ngân hàng, đơn giá, hạng mục chi, mẫu tin Sales, mẫu hợp đồng, nhắc hết hạn, **tự gửi bill qua app**, AI, thành viên, chia sẻ tòa, sao lưu, nhập / xuất Excel |

### Hợp đồng sắp hết hạn
Ngày ra của phòng (tự cập nhật khi tạo hợp đồng) → chuông 🔔 + Tổng quan báo các phòng còn ≤ *N* ngày (mặc định 30). Mỗi phòng có: **💬 Nhắc khách tái ký** (tin nhắn mẫu + mở Zalo), **✓ Đã tái ký** (gia hạn, tạo hợp đồng mới), **🚪 Khách sẽ ra → báo Sales** (chuyển *Sắp trống* và gửi danh bạ Sales).

### Tài khoản app của khách & gửi bill
- Lưu phòng có SĐT khách → app **tự tạo tài khoản khách** (SĐT mới) và hiện mã QR kích hoạt, hoặc **chỉ gắn phòng** nếu SĐT đã có tài khoản. Phòng chuyển *Trống* → tự ngắt (khách cũ vẫn xem lịch sử thời gian đã ở).
- Tab Phòng → **📱 Tài khoản app cho mọi khách**: làm cho cả tòa một lần.
- **Tự gửi bill qua app** (Cài đặt, mặc định bật lúc 20:00): mỗi ngày gửi các bill đã nhập đủ chỉ số. Vẫn có nút gửi tay ở tab Bill.
- Khách bấm *Tôi đã chuyển khoản* → chủ nhận thông báo → **✓ Xác nhận đã thu**.

### Xuất Excel
Sheet: Thông tin, Tổng hợp theo tháng (thu / chi / lãi / biên / kWh), Thu tháng, Chi phí, Thu thêm, Phòng, Hợp đồng; bản *tất cả tòa* có thêm sheet so sánh các tòa. Định dạng tiền, lọc, cố định tiêu đề, dòng TỔNG là công thức `SUM`.

---

## 4. Sales (môi giới)

- Trang **Tìm phòng**: tìm theo địa chỉ / tiện ích, lọc giá, trống ngay / sắp trống, sắp xếp; xem ảnh, giá, dịch vụ, cọc, liên hệ + hoa hồng của chủ; **copy tin đăng**, tải ảnh .zip, gọi / Zalo chủ.
- Chỉ thấy phòng **Trống / Sắp trống** mà chủ để **Công khai**, hoặc **Gửi riêng** cho mình qua danh bạ (khớp theo tài khoản hoặc SĐT – Sales đăng ký sau bằng đúng SĐT cũng tự thấy phòng đã gửi).
- Chuông 🔔: phòng mới được gửi.
- *Đang phát triển:* **chốt phòng (lock)** – Sales / chủ báo đã có khách cọc, mọi Sales nhận thông báo, chủ được nhắc gỡ phòng khỏi Sales; **lọc theo chủ nhà, tòa nhà, khu vực**. Phía máy chủ đã có, giao diện đang làm.

---

## 5. Khách thuê

- Quét **mã QR phòng** in cuối bill (hoặc chủ gửi qua Zalo) → đăng ký / đăng nhập bằng SĐT → thấy **hóa đơn tháng này** (mã QR thanh toán) và **hóa đơn các tháng trước** từ ngày vào ở. Nhiều người ở chung phòng đều quét được.
- Mã QR phòng có chữ ký bí mật; tự hết hiệu lực khi phòng đổi khách (đổi ngày vào) hoặc chuyển Trống; chủ có nút **Đổi mã**.
- Nút **Tôi đã chuyển khoản**, **Lưu ảnh hóa đơn**, gọi / Zalo chủ trọ; chuông báo hóa đơn chưa thanh toán; *Bật thông báo* (cần HTTPS).
- Chủ trọ / Sales cũng đang thuê phòng ở đâu đó: **Tài khoản → 🧾 Hóa đơn phòng tôi thuê**.

---

## 6. AI đọc ảnh (Claude)

- **Chụp đồng hồ điện** → AI đọc chỉ số kWh (bỏ phần thập phân), báo mức chắc chắn; app cảnh báo số nhỏ hơn kỳ trước, mức dùng bất thường, **seri đồng hồ khác phòng** (chụp nhầm). Ảnh lưu làm bằng chứng kể cả khi AI lỗi.
- **Chụp CCCD** (mặt trước + sau) → tự điền họ tên, ngày sinh, giới tính, số CCCD, ngày cấp, nơi cấp, thường trú, quê quán. Ảnh CCCD **không lưu** trong app.
- Model: `claude-opus-5-5`, structured outputs (JSON đúng schema), bật dự phòng phía máy chủ khi model từ chối.
- Bật: chủ hệ thống vào **Cài đặt → AI đọc ảnh** dán Claude API key (tạo ở console.anthropic.com), hoặc đặt biến môi trường `ANTHROPIC_API_KEY`. Key không bao giờ gửi xuống trình duyệt.
- Mỗi ảnh tính phí theo bảng giá Claude API; ảnh được gửi tới Anthropic để xử lý.

---

## 7. Dữ liệu, sao lưu, đóng gói

```
app/data/
├── users.db                 # tài khoản, phiên, thành viên tòa, lời mời, danh bạ Sales, tài khoản khách
├── buildings/<MÃ TÒA>/
│   ├── nhatro.db            # phòng, thu tháng, thu thêm, chi phí, hợp đồng, nhật ký chốt phòng, cài đặt
│   └── images/              # ảnh phòng, ảnh đồng hồ điện
├── ai.json                  # Claude API key (nếu nhập trong app)
└── secret.key               # khóa ký mã QR phòng (tạo tự động)
```

- **Thư mục `app/data/` không bao giờ đưa lên Git** (`.gitignore`) và không nằm trong gói phát hành.
- **Sao lưu một tòa**: Cài đặt → *Tải bản sao lưu (.zip)* (CSDL + ảnh). Sao lưu toàn bộ: chép cả thư mục `app/data/` khi app đang tắt.
- **Đóng gói để cài máy khác (không kèm dữ liệu)**: `cd app && python package.py` → `dist/QuanLyNhaTro_<ngày>.zip`. Máy mới chạy lên là hệ thống trống; muốn chuyển dữ liệu thì chép riêng `app/data/`.
- CSDL cũ tự nâng cấp cấu trúc khi khởi động (thêm cột / bảng mới, không mất dữ liệu).

---

## 8. Lệnh dòng lệnh

Chạy trong thư mục `app/`:

| Lệnh | Tác dụng |
|---|---|
| `python server.py` | Chạy app (chỉ máy này) |
| `python server.py --lan` | Cho điện thoại cùng Wi‑Fi truy cập |
| `python server.py --no-browser` | Không tự mở trình duyệt |
| `python server.py --reset-password <SĐT> <mật khẩu mới>` | Đặt lại mật khẩu khi quên |
| `python server.py --grant <MÃ TÒA> <SĐT> [admin\|manager\|viewer]` | Cấp quyền một tòa cho tài khoản |
| `python import_excel.py <file.xlsm> [--building S02] [--replace]` | Nhập dữ liệu từ file Excel cũ |
| `python seed_demo.py S01` / `--remove` | Tạo / xóa dữ liệu thu chi ảo tháng trước (ghi chú `[DEMO]`) để thử so sánh |
| `python seed_demo.py S01 --leases` / `--remove-leases` | Tạo / gỡ ngày ra (hết hạn HĐ) ảo để thử nhắc tái ký |
| `python package.py` | Đóng gói app (không kèm dữ liệu) ra `dist/` |

---

## 9. Cấu trúc mã nguồn

```
app/
├── server.py          # máy chủ HTTP (thư viện chuẩn), API JSON, quyền theo trường dữ liệu, tự gửi bill, chợ phòng Sales
├── auth.py            # tài khoản (SĐT), phiên, vai trò & quyền, lời mời chia sẻ tòa, danh bạ Sales, tài khoản khách
├── ai.py              # gọi Claude: đọc đồng hồ điện, đọc CCCD (structured outputs)
├── export_xlsx.py     # xuất Excel
├── import_excel.py    # nhập từ file Excel cũ
├── seed_demo.py       # dữ liệu ảo để thử
├── package.py         # đóng gói không kèm dữ liệu
├── run.bat / run-dienthoai.bat
└── static/
    ├── index.html, style.css, app.js   # giao diện 1 trang (JavaScript thuần, không build)
    ├── manifest.webmanifest, sw.js, icons/   # "Thêm vào màn hình chính"
    └── vendor/        # qrcode-generator 1.4.4, html2canvas 1.4.1 (chạy không cần mạng)
```

- **Giao diện**: một file `app.js`; quyền hiển thị tập trung ở bảng `CAP_RULES` (chỉ để giao diện gọn – bảo mật thật nằm ở máy chủ).
- **API** (`/api/...`): JSON, xác thực bằng cookie `sid` (HttpOnly). Tòa đang thao tác truyền qua header `X-Building` hoặc `?b=`.
- **Tính tiền**: `calc()` trong `app.js` và `export_xlsx.calc()` dùng cùng công thức: `kWh × giá điện + số người × giá nước + tiền phòng + phí DV + số xe × giá xe + thu thêm`.

---

## 10. Bảo mật & giới hạn

- Mật khẩu băm PBKDF2‑SHA256 (200.000 vòng); đăng nhập sai bị làm chậm; phiên 30 ngày, đổi mật khẩu đăng xuất thiết bị khác.
- **Không xác minh SĐT bằng OTP** – ai cũng đăng ký được bằng SĐT người khác (riêng tài khoản khách do chủ tạo sẵn phải kích hoạt bằng mã QR). Cần dịch vụ SMS OTP nếu muốn xác minh thật.
- Ai có ảnh bill (có mã QR phòng) xem được lịch sử hóa đơn phòng đó trong thời gian khách hiện tại – lộ thì bấm **Đổi mã**.
- App chạy trên máy chủ trọ: tắt máy là điện thoại / Sales / khách không vào được, bill tự gửi sẽ gửi bù khi mở lại. Muốn dùng mọi lúc, mọi nơi, có nút *Cài đặt app*, thông báo đẩy khi app đóng: cần đưa lên máy chủ có **HTTPS** (tên miền).
- Không tự gửi SMS / Zalo / email: thông báo nằm trong app (chuông), còn Zalo là *copy + mở chat* để chủ bấm gửi.
- Hợp đồng mẫu chỉ là mẫu tham khảo, không phải tư vấn pháp lý.
