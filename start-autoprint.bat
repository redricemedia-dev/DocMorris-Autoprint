@echo off
cd /d C:\docmorris-auto

call pm2 delete autoprint 2>nul
call pm2 delete dashboard 2>nul

call pm2 start autopilot.js --name autoprint
call pm2 start server.js --name dashboard

call pm2 save
call pm2 list

pause