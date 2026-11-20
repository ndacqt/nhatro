@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Lan dau chay (chua co toa nha nao): nhap tu file Excel nam canh thu muc app
if not exist "data\buildings\S01\nhatro.db" if not exist "data\nhatro.db" (
  if exist "..\QuanLyThuChi_NhaTro.xlsm" (
    echo Lan dau chay: nhap du lieu tu file Excel...
    python import_excel.py "..\QuanLyThuChi_NhaTro.xlsm"
  )
)
python server.py %*
pause
