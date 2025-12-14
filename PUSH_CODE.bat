@echo off
echo ========================================
echo Push code len GitHub - Agora Backend
echo ========================================
echo.

cd /d "%~dp0"

echo Dang o thu muc: %CD%
echo.

echo [1/6] Khoi tao git...
git init
echo.

echo [2/6] Them tat ca files...
git add .
echo.

echo [3/6] Commit code...
git commit -m "Initial commit: Agora token server"
echo.

echo [4/6] Doi ten branch thanh main...
git branch -M main
echo.

echo [5/6] Ket noi voi GitHub repository...
git remote add origin https://github.com/Phu211/agora-token.git
echo.

echo [6/6] Push code len GitHub...
echo.
echo ⚠️  Neu GitHub yeu cau authentication:
echo    - Username: Phu211
echo    - Password: Dung Personal Access Token (khong phai password GitHub)
echo.
git push -u origin main

echo.
echo ========================================
echo Hoan thanh!
echo ========================================
echo.
echo Kiem tra: https://github.com/Phu211/agora-token
echo.
pause
