@echo off
chcp 65001 >nul
echo.
echo  ================================================
echo   AbyQA — Deploiement GitHub
echo  ================================================
echo.
echo  Deploiement en cours...
echo.

git add .

echo.
set /p MSG=" Message de commit : "

if "%MSG%"=="" (
  echo.
  echo  [ERREUR] Message vide — abandon.
  echo.
  pause
  exit /b 1
)

git commit -m "%MSG%"

echo.
echo  Push vers GitHub...
echo.

git push

echo.
echo  ================================================
echo   OK Deploye ! Attends 2-3 min sur Render
echo  ================================================
echo.
pause
