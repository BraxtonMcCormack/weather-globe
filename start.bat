@echo off
rem Starts the Weather Globe server (auto-downloads new GFS runs) and opens it in your browser.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Creating Python environment...
  python -m venv .venv || goto :error
  .venv\Scripts\python -m pip install -q -r requirements.txt || goto :error
)
start "" http://localhost:8765
.venv\Scripts\python -m backend.server --port 8765
goto :eof
:error
echo Setup failed. Make sure Python 3.11+ is installed and on PATH.
pause
