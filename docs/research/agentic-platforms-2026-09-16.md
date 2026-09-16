# Nghiên cứu nền tảng agentic — 16/09/2026

Phương pháp: Exa, 4 luồng tìm kiếm / 20 kết quả được yêu cầu (không đồng nghĩa 20 nguồn được xác minh). Đọc tài liệu chính thức và loại các kết quả không đúng sản phẩm. Đây là nghiên cứu thiết kế, chưa có benchmark thực nghiệm đối thủ.

| Nguồn đã đọc | Điều được nguồn mô tả | Quyết định cho SAND |
|---|---|---|
| [Amoeba](https://useamoeba.com/) | Claude Code/Codex CLI local, shared coordination, overlap warnings và worktree riêng; worktree không phải sandbox OS | Hiện rõ ai làm gì, đầu vào/phụ thuộc/kết quả; CLI agent adapters và cộng tác nhiều người để bước 2 |
| [Cursor Agent](https://cursor.com/docs/agent/overview) | Instructions + tools + model; checkpoints, queue/steering | Tách định nghĩa vai trò, model, dữ liệu và quyền; người dùng chỉnh chi tiết theo từng bước |
| [Cursor multi-agent](https://cursor.com/help/ai-features/multi-agent) | Agent song song và subagents tách context | DAG có cạnh dữ liệu tường minh, nhánh độc lập được chạy đồng thời |
| [Antigravity IDE](https://antigravity.google/docs/ide/overview/) | Editor/browser, parallel agents, artifacts/transparency | Artifact là kết quả chính cho chuyên gia lĩnh vực, IDE code là một bề mặt phụ |
| [Antigravity review](https://www.antigravity.google/docs/artifact-review/) | Review plan/artifact trước hành động | Human-review node và hiển thị nội dung cần duyệt, không coi model tự xác nhận là approval |
| [n8n human review](https://docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools) | Pause tool call, gửi tham số cho reviewer, approve/deny | MVP duyệt đầu ra trước bước tiếp theo; per-tool approval là bước 2, không đánh đồng hai loại |

Nhận định thiết kế (suy luận, không phải tuyên bố của đối thủ): chuyên gia ít viết code cần một đường bắt đầu bằng template, hiểu rõ dữ liệu chuyển giữa bước và kiểm tra sản phẩm đầu ra. Canvas vô hạn hoặc một cửa sổ chat duy nhất không tự giải quyết nhu cầu đó. SAND dùng sơ đồ hữu hạn + form cấu hình + run inspector, không sao chép giao diện của các sản phẩm trên.

## Hợp đồng tích hợp được tham khảo

- [Ollama chat](https://docs.ollama.com/api/chat): POST /api/chat, non-streaming, message.content, prompt_eval_count/eval_count.
- [OpenRouter chat](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request): POST /api/v1/chat/completions, bearer, response choices/usage. Tích hợp basic text không đồng nghĩa đầy đủ tool/multimodal/streaming support.
- Nguồn model/capability/giá vẫn lấy từ discovery có timestamp; unknown không được biến thành 0.

Không lấy số liệu marketing làm kết quả benchmark. URL n8n cũ đã trả 404; dùng URL hiện tại ở bảng trên. Mọi giá trị hiệu năng SAND phải đến từ test/run thực tế riêng.
