---
name: oracle-to-mysql-migration
description: >
  Oracle SQL 到 MySQL 迁移工具。两步流程：① 先用 awk 删除 SQL 块中的 // 注释 ② 再运行转换工具。
  自动完成：NVL→IFNULL、TO_CHAR→CAST、TO_DATE→STR_TO_DATE、INSTR→LOCATE、TO_NUMBER→CAST DECIMAL、
  ADD_MONTHS→DATE_ADD、MONTHS_BETWEEN→TIMESTAMPDIFF、rownum→ROW_NUMBER、||→CONCAT、SYSDATE→NOW、
  SUBSTR→SUBSTRING、DECODE→CASE WHEN、PIVOT→CASE WHEN、TRUNC→DATE、NULLS FIRST/LAST 删除等。
  自动将 Oracle `(+)` 外连接语法转换为标准 `LEFT JOIN`。当用户要求将 SQL 从 Oracle 迁移到 MySQL 时触发。
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [oracle, mysql, migration, sql, database]
---

# Oracle 到 MySQL 迁移

**运行转换工具**

```bash
node E:\Hermes\skills\oracle-to-mysql-migration\scripts\index.js --target <目录或文件>
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
15. **(+) 外连接转换** — 将 Oracle `(+)` 语法转换为标准 `LEFT JOIN`

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
| `||` | `CONCAT()` | 模板外部 + 字符串拼接块 |
| `'str'||expr||'str'` | `CONCAT('str', expr, 'str')` | 字符串拼接块 |
| `" + var + "` | `` `${var}` `` | 模板字面量重构 |
| `(+)`（表连接） | `LEFT JOIN ... ON` | 见下方 `(+)` 转换规则 |

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

## 步骤 2：TO_CHAR 批量正则替换（0 token）

工具报告的 `complexPatterns` 中，`TO_CHAR(round(...))` 占绝大多数（常 200+ 个），但它们遵循固定的平衡括号结构，可用脚本批量替换，无需 LLM。

```bash
node E:\Hermes\skills\oracle-to-mysql-migration\scripts\fix-tochar.js --file <目标html文件>
```

脚本处理：
- `to_char(round(X,2))` → `CAST(ROUND(X,2) AS CHAR)`（平衡括号匹配，支持嵌套 IFNULL/CASE）
- `DECODE(expr, s1, r1, ..., default)` → `CASE WHEN expr=s1 THEN r1 ... ELSE default END`
- 跳过 `//` 注释行中的匹配

**运行时机：** 工具报告 `complexPatterns` 非空时，在 LLM 处理前先跑此脚本。通常可消除 95%+ 的 complexPatterns。

## LLM 处理（仅残留边缘情况）

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

1. **`(+)` 必须转换为标准 JOIN** — Oracle `(+)` 外连接语法对应 `LEFT JOIN`（详见下方转换规则）
2. **仅修改 `.html` 文件** — 不修改 `.fpd` 源文件
3. **跳过注释中的 SQL** — `//`、`/* */`、`<!-- -->` 注释内的 SQL 不转换

## `(+)`（Oracle 外连接）转换规则

Oracle 的 `(+)` 是旧式外连接标记，放在列名后表示该列所在表是"可补 NULL"侧。

### 表连接条件中的 `(+)`

```sql
-- Oracle: 逗号连接 + WHERE
FROM (SELECT ...) T, (SELECT ...) D
WHERE T.xh(+) = D.xh    -- (+) 在 T 侧 → D 是主表

-- MySQL: LEFT JOIN
FROM (SELECT ...) D
LEFT JOIN (SELECT ...) T ON T.xh = D.xh
```

规则口诀：**`(+)` 在哪侧，哪侧就是 LEFT JOIN 的右表**（即补 NULL 侧）。

| Oracle 写法 | MySQL 等价 |
|-------------|-----------|
| `WHERE a.id(+) = b.id` | `FROM a RIGHT JOIN b ON a.id = b.id` 或 `FROM b LEFT JOIN a ON a.id = b.id` |
| `WHERE a.id = b.id(+)` | `FROM a LEFT JOIN b ON a.id = b.id` |

### WHERE 过滤条件中的 `(+)`

```sql
-- Oracle: ssyf(+) = 'value' 表示条件作为外连接条件
WHERE zsxm_dm = '99999' and ssyf(+) = '...'

-- MySQL: 条件直接放在子查询 WHERE 中即可
-- LEFT JOIN 语义自动处理无匹配行填充 NULL
```

原因：转为 `LEFT JOIN` 后，子查询内的过滤条件自然成为"外连接条件"的一部分——右表无匹配时所有列自动为 NULL。

### 完整转换示例

```sql
-- Oracle 原始
SELECT d.xh_j, d.zccs_j MC, ...
FROM (SELECT * FROM T1 WHERE col1(+) = 'v') T,
     (SELECT * FROM T2 WHERE ...) D
WHERE T.xh(+) = D.xh
ORDER BY D.px

-- MySQL 转换后
SELECT d.xh_j, d.zccs_j MC, ...
FROM (SELECT * FROM T2 WHERE ...) D
LEFT JOIN (SELECT * FROM T1 WHERE col1 = 'v') T ON T.xh = D.xh
ORDER BY D.px
```

## 设计约束

1. **仅修改 `.html` 文件** — 不修改 `.fpd` 源文件
2. **跳过注释中的 SQL** — `//`、`/* */`、`<!-- -->` 注释内的 SQL 不转换
3. **模板字面量优先** — 先重构模板字面量，再处理 `||`→CONCAT，避免 SQL 内部 `||` 被误转
4. **保护 JS 方法** — 简单替换使用 `(?<!\.)` 负向回顾，避免将 `variable.substr()` 等 JS 方法误转为 SQL 函数
5. **支持表达式模板** — 模板字面量重构支持 `" + (expr) + "` 模式（含嵌套括号）
6. **模板字面量闭合** — backtick 行后有续行时，block 结束前自动闭合 pending 的模板字面量
7. **SQL 片段变量检测** — `str_where*`、`lbxz` 等已知含引号的变量保持 `` ` + var + ` `` 拼接，不嵌入模板字面量
8. **跨行属性访问续行** — `parent.gpm` 被拆到两行（下一行以 `.cxtj` 开头）时自动识别为续行

## 项目结构

```
oracle-to-mysql-migration/
├── README.md              # 项目说明
├── SKILL.md               # 技能定义
├── scripts/
│   ├── index.js           # 主转换工具
│   ├── config.json        # 配置文件
│   ├── preprocess-report.json  # 输出报告（自动生成）
│   └── run.bat            # 运行脚本
└── references/
    └── migration-rules.md # 完整迁移规则参考
```
