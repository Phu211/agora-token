# Hướng dẫn Push code lên GitHub - Windows

## 📍 Bước 1: Di chuyển đến thư mục đúng

Mở Command Prompt hoặc PowerShell và chạy:

```bash
cd d:\PTUDDDDNT\dack\agora-backend
```

Hoặc nếu bạn đang ở thư mục gốc của dự án:

```bash
cd d:\PTUDDDDNT\dack
cd agora-backend
```

## ✅ Bước 2: Kiểm tra thư mục

Chạy lệnh để xem các file:

```bash
dir
```

Bạn sẽ thấy:
- `server.js`
- `package.json`
- `README.md`
- `.gitignore`
- v.v.

## 📤 Bước 3: Push code lên GitHub

Chạy các lệnh sau **theo thứ tự**:

```bash
# 1. Khởi tạo git (nếu chưa có)
git init

# 2. Thêm tất cả files
git add .

# 3. Commit code
git commit -m "Initial commit: Agora token server"

# 4. Đổi tên branch thành main
git branch -M main

# 5. Kết nối với repository GitHub
git remote add origin https://github.com/Phu211/agora-token.git

# 6. Push code lên GitHub
git push -u origin main
```

## ⚠️ Lưu ý khi Push

### Nếu gặp lỗi authentication:

**Cách 1: Dùng Personal Access Token**

1. Vào GitHub: https://github.com/settings/tokens
2. Click **Generate new token (classic)**
3. Chọn scope: `repo` (full control)
4. Copy token
5. Khi push, nhập:
   - Username: `Phu211`
   - Password: **Dán token** (không phải password GitHub)

**Cách 2: Dùng GitHub Desktop**

1. Download: https://desktop.github.com/
2. Mở GitHub Desktop
3. File → Add Local Repository
4. Chọn thư mục `d:\PTUDDDDNT\dack\agora-backend`
5. Publish repository

**Cách 3: Dùng SSH**

1. Tạo SSH key (nếu chưa có)
2. Thêm SSH key vào GitHub
3. Dùng SSH URL: `git@github.com:Phu211/agora-token.git`

## ✅ Kiểm tra thành công

Sau khi push thành công, truy cập:
```
https://github.com/Phu211/agora-token
```

Bạn sẽ thấy tất cả files đã được upload.

## 🚀 Bước tiếp theo

Sau khi push code lên GitHub thành công, tiếp tục với:
- Xem file `DEPLOY_RENDER_CHI_TIET.md` - Bước 3: Deploy trên Render
