@echo off
setlocal
cd /d "%~dp0"
title 麦门知己 - 启动器

echo ==================================================
echo    麦门知己 - 一键启动
echo ==================================================
echo.

rem ---------- 0. 环境校验 ----------
if not exist "server\package.json" goto ERR_NOSERVER
where node >nul 2>nul
if errorlevel 1 goto ERR_NONODE

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo [1/6] Node %NODEV%

rem ---------- 1. .env ----------
if exist "server\.env" goto ENV_OK
if not exist "server\.env.example" goto ERR_NOENV
copy "server\.env.example" "server\.env" >nul
echo [2/6] 已从 .env.example 生成 server\.env
echo       请填写 LLM_API_KEY、JWT_SECRET、TOKEN_ENC_KEY
goto ENV_DONE
:ENV_OK
echo [2/6] server\.env 已存在
:ENV_DONE

rem ---------- 2. 依赖 ----------
if exist "server\node_modules" goto DEP_OK
echo [3/6] 首次运行，正在安装依赖，约 1-3 分钟...
pushd server
call npm install
if errorlevel 1 goto ERR_NPM
popd
goto DEP_DONE
:DEP_OK
echo [3/6] 依赖已安装
:DEP_DONE

rem ---------- 3. 端口 ----------
set "PORT=3000"
for /f "usebackq tokens=1,2 delims==" %%a in ("server\.env") do if /i "%%a"=="PORT" if not "%%b"=="" set "PORT=%%b"

call :FIND_PID
if not defined FOUNDPID goto PORT_FREE
echo [4/6] 端口 %PORT% 已被 PID %FOUNDPID% 占用，正在重启...
taskkill /F /PID %FOUNDPID% >nul 2>nul
for /l %%i in (1,1,10) do (
  timeout /t 1 /nobreak >nul
  call :FIND_PID
  if not defined FOUNDPID goto PORT_FREE
)
echo [X] 端口 %PORT% 一直没释放，请手动检查
echo     命令：netstat -ano ^| findstr :%PORT%
goto ERR_PORT
:PORT_FREE
echo [4/6] 端口 %PORT% 可用

rem ---------- 4. 编译 ----------
echo [5/6] 编译 TypeScript...
pushd server
call npm run build
if errorlevel 1 goto ERR_BUILD
popd
if not exist "server\dist\index.js" goto ERR_BUILD
echo       编译完成

rem ---------- 5. 启动 ----------
echo [6/6] 启动服务
start "麦门知己 后端日志" /D "%~dp0server" cmd /k node dist/index.js
echo.
echo       等待服务就绪...

set "READY="
set /a TRIES=0
:WAIT_LOOP
timeout /t 1 /nobreak >nul
set /a TRIES+=1
curl -s -m 2 -o nul "http://127.0.0.1:%PORT%/api/health"
if not errorlevel 1 set "READY=1"
if defined READY goto HEALTHY
if %TRIES% LSS 25 goto WAIT_LOOP

:HEALTHY
echo.
echo ==================================================
if not defined READY goto NOT_READY
echo    启动成功
echo    地址：http://localhost:%PORT%
echo.
echo    后端日志在另一个窗口「麦门知己 后端日志」
echo    关闭那个窗口就是停止服务
start "" "http://localhost:%PORT%"
goto THE_END

:NOT_READY
echo    服务没能在 25 秒内就绪
echo    请切到「麦门知己 后端日志」窗口看报错
echo    常见原因：JWT_SECRET 少于 32 字符，或 TOKEN_ENC_KEY 不是 64 位 hex
goto THE_END

rem ---------- 子程序：找占用端口的 PID ----------
:FIND_PID
set "FOUNDPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING"') do if not defined FOUNDPID set "FOUNDPID=%%p"
goto :eof

rem ---------- 错误出口 ----------
:ERR_NOSERVER
echo [X] 找不到 server\package.json
echo     请把 start.bat 放在项目根目录，与 server、web 同级
goto FAIL
:ERR_NONODE
echo [X] 没检测到 Node.js，请先安装 Node 22 或更高版本
echo     https://nodejs.org
goto FAIL
:ERR_NOENV
echo [X] 缺少 server\.env，也没有 .env.example 可复制
goto FAIL
:ERR_NPM
popd
echo [X] npm install 失败，请检查网络或 npm 配置
goto FAIL
:ERR_BUILD
popd
echo [X] 编译失败，请按上面的报错修复后再试
goto FAIL
:ERR_PORT
echo     请先手动结束占用端口的进程
goto FAIL

:FAIL
echo.
pause
exit /b 1

:THE_END
echo ==================================================
echo.
pause
endlocal
exit /b 0
