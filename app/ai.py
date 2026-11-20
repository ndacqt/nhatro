"""Đọc ảnh bằng Claude: chỉ số đồng hồ điện và thông tin căn cước (CCCD).

API key lấy từ (theo thứ tự): biến môi trường ANTHROPIC_API_KEY, hoặc data/ai.json do chủ hệ thống
nhập trong app (Cài đặt → AI). Key không bao giờ gửi xuống trình duyệt.
"""
import base64
import json
import os

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
KEY_FILE = os.path.join(DATA, "ai.json")
MODEL = "claude-opus-5-5"
# Khi model chính từ chối (hiếm), API tự chạy lại trên model dự phòng phù hợp.
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_IMAGE_BYTES = 5 * 1024 * 1024


class AIError(Exception):
    pass


def saved_key():
    try:
        with open(KEY_FILE, encoding="utf-8") as f:
            return json.load(f).get("api_key") or ""
    except (OSError, ValueError):
        return ""


def save_key(key):
    key = (key or "").strip()
    os.makedirs(DATA, exist_ok=True)
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        json.dump({"api_key": key}, f)


def status():
    try:
        import anthropic  # noqa: F401
        sdk = True
    except ImportError:
        sdk = False
    src = "env" if os.environ.get("ANTHROPIC_API_KEY") else ("app" if saved_key() else "")
    return {"sdk": sdk, "enabled": sdk and bool(src), "key_source": src, "model": MODEL}


def _client():
    try:
        import anthropic
    except ImportError:
        raise AIError("Chưa cài thư viện AI. Chạy: python -m pip install anthropic")
    if os.environ.get("ANTHROPIC_API_KEY"):
        return anthropic.Anthropic(max_retries=2)
    key = saved_key()
    if not key:
        raise AIError("Chưa bật AI: chủ hệ thống cần nhập Claude API key ở Cài đặt → AI.")
    return anthropic.Anthropic(api_key=key, max_retries=2)


def _image_block(data, media_type):
    if len(data) > MAX_IMAGE_BYTES:
        raise AIError("Ảnh quá lớn (tối đa 5MB)")
    if media_type not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        raise AIError("Chỉ nhận ảnh JPG/PNG/WEBP")
    return {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                         "data": base64.standard_b64encode(data).decode("ascii")}}


def _ask(images, prompt, schema, effort):
    """Gửi ảnh + yêu cầu, nhận JSON đúng schema (structured outputs)."""
    import anthropic
    client = _client()
    content = [_image_block(d, t) for d, t in images] + [{"type": "text", "text": prompt}]
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.AuthenticationError:
        raise AIError("Claude API key không hợp lệ – kiểm tra lại ở Cài đặt → AI.")
    except anthropic.PermissionDeniedError:
        raise AIError("API key không có quyền dùng model này.")
    except anthropic.RateLimitError:
        raise AIError("AI đang quá tải hoặc hết hạn mức – thử lại sau ít phút.")
    except anthropic.BadRequestError as e:
        raise AIError("AI không xử lý được ảnh này: " + str(e.message))
    except anthropic.APIConnectionError:
        raise AIError("Không kết nối được tới AI – kiểm tra internet của máy chạy app.")
    except anthropic.APIStatusError as e:
        raise AIError(f"Lỗi từ AI ({e.status_code}) – thử lại sau.")
    if resp.stop_reason == "refusal":
        raise AIError("AI từ chối xử lý ảnh này – hãy nhập tay.")
    if resp.stop_reason == "max_tokens":
        raise AIError("AI trả lời bị cắt ngang – thử lại.")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except ValueError:
        raise AIError("AI trả về dữ liệu không đọc được – thử lại.")


# ---------------- đồng hồ điện ----------------
METER_SCHEMA = {
    "type": "object",
    "properties": {
        "is_meter": {"type": "boolean", "description": "Ảnh có phải đồng hồ điện không"},
        "readable": {"type": "boolean", "description": "Đọc được chỉ số kWh tổng hay không"},
        "reading": {"type": "integer", "description": "Chỉ số kWh tổng, chỉ phần nguyên (bỏ chữ số thập phân). 0 nếu không đọc được"},
        "digits_seen": {"type": "string", "description": "Dãy chữ số nhìn thấy đúng như trên mặt đồng hồ, kể cả phần thập phân, vd '15434.7'"},
        "meter_type": {"type": "string", "enum": ["co", "dien_tu", "khac"]},
        "serial": {"type": "string", "description": "Số seri / số chế tạo của đồng hồ nếu nhìn thấy, ngược lại chuỗi rỗng"},
        "confidence": {"type": "string", "enum": ["cao", "trung_binh", "thap"]},
        "note": {"type": "string", "description": "Ghi chú ngắn bằng tiếng Việt: chữ số nào mờ/lóa, đồng hồ đang hiện màn hình gì..."},
    },
    "required": ["is_meter", "readable", "reading", "digits_seen", "meter_type", "serial", "confidence", "note"],
    "additionalProperties": False,
}


def read_meter(image, media_type, room_code, old_idx=None, prev_kwh=None):
    ctx = []
    if old_idx is not None:
        ctx.append(f"Chỉ số kỳ trước của phòng này: {int(old_idx)}.")
    if prev_kwh:
        ctx.append(f"Tháng trước phòng dùng khoảng {int(prev_kwh)} kWh.")
    prompt = (
        f"Ảnh chụp đồng hồ điện của phòng trọ {room_code}. Hãy đọc chỉ số điện năng tiêu thụ tổng (kWh) đang hiển thị.\n"
        "- Đồng hồ cơ: đọc dãy số trên bộ đếm từ trái sang phải. Ô cuối có màu khác (thường đỏ) hoặc sau dấu phẩy là phần thập phân – bỏ phần đó, chỉ lấy phần nguyên.\n"
        "- Đồng hồ điện tử: chỉ lấy màn hình tổng điện năng (kWh, mã 1.8.0 / Total / A+). Nếu màn hình đang hiện thông số khác (giờ, điện áp, công suất...) thì readable=false và ghi rõ trong note.\n"
        "- Nếu một chữ số đang lăn giữa hai số, chọn số nhỏ hơn.\n"
        "- Đọc đúng những gì nhìn thấy trên ảnh, KHÔNG suy ra từ số kỳ trước. Số kỳ trước chỉ để bạn kiểm tra lại; nếu số đọc được nhỏ hơn số kỳ trước hoặc chênh lệch bất thường, hãy nhìn lại kỹ và nói rõ trong note.\n"
        "- Nếu ảnh mờ, lóa, bị che hoặc không phải đồng hồ điện: readable=false, reading=0, confidence='thap'.\n"
        + " ".join(ctx)
    )
    r = _ask([(image, media_type)], prompt, METER_SCHEMA, effort="high")
    r["reading"] = int(r.get("reading") or 0)
    return r


# ---------------- căn cước công dân ----------------
ID_FIELDS = ["full_name", "id_number", "date_of_birth", "sex", "nationality", "hometown", "residence",
             "issue_date", "expiry_date", "issued_by"]
ID_SCHEMA = {
    "type": "object",
    "properties": {
        "is_id_card": {"type": "boolean", "description": "Có phải thẻ Căn cước / CCCD / CMND Việt Nam không"},
        "sides": {"type": "string", "enum": ["truoc", "sau", "ca_hai", "khong_ro"]},
        "full_name": {"type": "string", "description": "Họ và tên, viết HOA có dấu như trên thẻ"},
        "id_number": {"type": "string", "description": "Số định danh / số CCCD 12 số (hoặc CMND 9 số), chỉ chữ số"},
        "date_of_birth": {"type": "string", "description": "dd/mm/yyyy"},
        "sex": {"type": "string", "description": "Nam / Nữ"},
        "nationality": {"type": "string"},
        "hometown": {"type": "string", "description": "Quê quán, hoặc Nơi đăng ký khai sinh (thẻ mẫu 2024)"},
        "residence": {"type": "string", "description": "Nơi thường trú, hoặc Nơi cư trú (thẻ mẫu 2024)"},
        "issue_date": {"type": "string", "description": "Ngày cấp dd/mm/yyyy (thường ở mặt sau)"},
        "expiry_date": {"type": "string", "description": "Có giá trị đến dd/mm/yyyy, hoặc 'Không thời hạn'"},
        "issued_by": {"type": "string", "description": "Nơi cấp / cơ quan cấp (thường ở mặt sau), vd 'Cục Cảnh sát QLHC về TTXH' hoặc 'Bộ Công an'"},
        "unclear_fields": {"type": "array", "items": {"type": "string"}, "description": "Tên các trường đọc không chắc chắn"},
        "note": {"type": "string", "description": "Ghi chú ngắn tiếng Việt"},
    },
    "required": ["is_id_card", "sides"] + ID_FIELDS + ["unclear_fields", "note"],
    "additionalProperties": False,
}


def read_id_card(images):
    prompt = (
        "Đây là ảnh thẻ Căn cước công dân (CCCD) / Căn cước / CMND Việt Nam của người thuê trọ (có thể gồm mặt trước và mặt sau). "
        "Trích xuất thông tin để điền hợp đồng thuê nhà và đăng ký tạm trú.\n"
        "- Chép đúng chữ trên thẻ, giữ dấu tiếng Việt. Ngày theo dạng dd/mm/yyyy.\n"
        "- Trường nào không có trên ảnh (vd ngày cấp nằm ở mặt sau chưa chụp) thì để chuỗi rỗng – không đoán.\n"
        "- Không đọc mã QR, chỉ đọc chữ in. Liệt kê trường không chắc chắn trong unclear_fields.\n"
        "- Nếu không phải thẻ căn cước: is_id_card=false và để trống các trường."
    )
    return _ask(images, prompt, ID_SCHEMA, effort="medium")
