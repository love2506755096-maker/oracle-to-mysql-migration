---
name: oracle-to-mysql-migration
description: >
  Oracle SQL 到 MySQL 迁移工具。两步流程：① 先用 awk 删除 SQL 块中的 // 注释 ② 再运行转换工具。
  自动完成：NVL→IFNULL、TO_CHAR→CAST、TO_DATE→STR_TO_DATE、INSTR→LOCATE、TO_NUMBER→CAST DECIMAL、
  ADD_MONTHS→DATE_ADD、MONTHS_BETWEEN→TIMESTAMPDIFF、rownum→ROW_NUMBER、||→CONCAT、SYSDATE→NOW、
  SUBSTR→SUBSTRING、DECODE→CASE WHEN、PIVOT→CASE WHEN、TRUNC→DATE、NULLS FIRST/LAST 删除等。
  保留 (+) 运算符原样。当用户要求将 SQL 从 Oracle 迁移到 MySQL 时触发。
---

# Oracle 到 MySQL 迁移

** 运行转换工具**

```bash
node C:\Users\25067\.claude\skills\oracle-to-mysql-migration\scripts\index.js --target <目录或文件>
```

> SQL 尾部（FROM/WHERE 子句）无法被纳入模板字面量。先删注释再转换可确保完整覆盖。

## 自动转换（0 token）

工具按以下顺序执行转换（顺序很重要）：

1. **简单关键词替换** — NVL→IFNULL、SUBSTR→SUBSTRING 等
2. **模式替换** — rownum→ROW_NUMBER、TO_CHAR(ROUND(IFNULL→CAST、TRUNC(NOW())→DATE(NOW())、NULLS FIRST/LAST 删除
3. **TO_CHAR(date, 'format')** → DATE_FORMAT
4. **合并跨行 to_char** — 字符串拼接中被 `+` 拆分的 to_char 合并为单行
5. **TO_CHAR(number)** → CAST(number AS CHAR)
6. **TO_DATE** → STR_TO_DATE（复用格式映射表）
7. **INSTR** → LOCATE（参数顺序反转）
8. **TO_NUMBER** → CAST(expr AS DECIMAL)
9. **ADD_MONTHS** → DATE_ADD/DATE_SUB（负数自动识别）
10. **MONTHS_BETWEEN** → TIMESTAMPDIFF（参数顺序反转）
11. **模板字面量重构** — 多行/单行 SQL 拼接 → 模板字面量（先于 ||→CONCAT，避免 SQL 内部 || 被误转）
12. **DECODE → CASE WHEN** — 自动转换嵌套 DECODE，支持 NULL 比较
13. **PIVOT 转换** — `PIVOT(SUM(col) alias FOR key IN (...))` → `SUM(CASE WHEN key='v' THEN col ELSE 0 END) AS alias`
14. **||→CONCAT** — 转换模板字面量外部和字符串拼接块中的 ||

| Oracle | MySQL | 方式 |
|--------|-------|------|
| `//` 注释 | 删除 | 预处理（避免阻断 SQL 拼接链） |
| `NVL(` | `IFNULL(` | 简单替换 |
| `NVL2(` | `IF(` | 简单替换 |
| `SUBSTR(` | `SUBSTRING(` | 简单替换 |
| `LENGTH(` | `CHAR_LENGTH(` | 简单替换 |
| `LENGTHB(` | `LENGTH(` | 简单替换 |
| `SYSDATE` | `NOW()` | 简单替换 |
| `sys_guid()` | `REPLACE(UUID(), '-', '')` | 简单替换 |
| `select rownum rn` | `select ROW_NUMBER() OVER() AS rn` | 模式替换 |
| `AND ROWNUM = 1` | `LIMIT 1` | 模式替换 |
| `TRUNC(NOW())` | `DATE(NOW())` | 模式替换 |
| `ORDER BY col NULLS FIRST` | `ORDER BY col`（删除） | 正则替换 |
| `ORDER BY col NULLS LAST` | `ORDER BY col`（删除） | 正则替换 |
| `TO_CHAR(expr, 'format')` | `DATE_FORMAT(expr, '%format')` | 结构化替换 |
| `to_char(round(expr,2))` | `CAST(round(expr,2) AS CHAR)` | 跨行合并+结构化替换 |
| `TO_CHAR(ROUND(IFNULL(` | `CAST(ROUND(IFNULL(` + `AS CHAR)` | 结构化替换 |
| `TO_DATE(str, 'format')` | `STR_TO_DATE(str, '%format')` | 结构化替换 |
| `INSTR(str, substr)` | `LOCATE(substr, str)` | 结构化替换（参数反转） |
| `TO_NUMBER(expr)` | `CAST(expr AS DECIMAL)` | 结构化替换 |
| `ADD_MONTHS(date, N)` | `DATE_ADD(date, INTERVAL N MONTH)` | 结构化替换 |
| `ADD_MONTHS(date, -N)` | `DATE_SUB(date, INTERVAL N MONTH)` | 结构化替换 |
| `MONTHS_BETWEEN(d1, d2)` | `TIMESTAMPDIFF(MONTH, d2, d1)` | 结构化替换（参数反转） |
| `DECODE(expr, s1, r1, ..., default)` | `CASE WHEN expr=s1 THEN r1 ... ELSE default END` | DECODE 转换 |
| `PIVOT(SUM(col) alias FOR key IN ('v1' C1))` | `SUM(CASE WHEN key='v1' THEN col ELSE 0 END) AS C1_alias` | PIVOT 转换 |
| `\|\|` | `CONCAT()` | 模板外部 + 字符串拼接块 |
| `'str'\|\|expr\|\|'str'` | `CONCAT('str', expr, 'str')` | 字符串拼接块 |
| `" + var + "` | `` `${var}` `` | 模板字面量重构 |
| `(+)` | `(+)` | 保留原样 |

### PIVOT 转换说明

工具自动将 Oracle PIVOT 语法转换为 MySQL CASE WHEN：
- 静态 IN 值：直接生成 `SUM(CASE WHEN ... END)` 表达式
- 模板变量 IN（如 `${swjg_tj}`）：替换为 `${pivotCols}`，**需 LLM 手动添加 `pivotCols` 生成代码和 GROUP BY**

## 报告

工具输出 `scripts/preprocess-report.json`（保存在技能目录，不污染项目目录）：
- 每个文件的自动替换数量
- `pivotConversions`：PIVOT 转换数量
- `templateLiteralFailed`：无法自动转换的模板字面量块（需 LLM）
- `complexPatterns`：需 LLM 处理的复杂 Oracle 模式

## LLM 处理（仅边缘情况）

工具报告 `templateLiteralFailed` 或 `complexPatterns` 非空时，才需要 LLM 介入：

| 模式 | 转换规则 |
|------|---------|
| `LISTAGG(col, ',') WITHIN GROUP (ORDER BY col)` | → `GROUP_CONCAT(col ORDER BY col SEPARATOR ',')` |
| `MERGE INTO ...` | → `INSERT INTO ... ON DUPLICATE KEY UPDATE ...` |
| `CONNECT BY PRIOR ...` | → `WITH RECURSIVE cte AS (...)` |
| `MINUS` | → `NOT EXISTS` |
| ROWNUM 分页（`WHERE ROWNUM <= N`） | → 嵌套子查询 + `LIMIT` |

完整规则参考：[references/migration-rules.md](references/migration-rules.md)

## 重要规则

1. **保留 `(+)` 原样** — 不转换为 LEFT/RIGHT JOIN
2. **仅修改 `.html` 文件** — 不修改 `.fpd` 源文件
3. **跳过 `/* */` 和 `<!-- -->` 注释** — 其中的 SQL 不转换
