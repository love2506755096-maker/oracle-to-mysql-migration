@echo off
REM Oracle-to-MySQL 预处理工具
REM 用法: run.bat <目标目录或文件> [--config <配置文件>]
REM 示例: run.bat D:\Project\dcits-cxtj-app\views\bi\sgs\xwqy\2025njsjftjhs\sj\zclbtjb\sg_lb_4

node "%~dp0index.js" --target %*
pause
