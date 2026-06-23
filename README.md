# Oracle-to-MySQL Migration Tool

Oracle SQL 自动迁移到 MySQL 的 Node.js 命令行工具。专为 BI 报表系统国产化改造设计，将 `.fpd` 报表文件中嵌入的 Oracle SQL 转换为 MySQL 兼容语法。

## 功能特性

- **零 token 消耗** — 纯正则/字符串处理，不依赖 LLM
- **批量处理** — 支持目录递归扫描，一次转换整个模块
- **模板字面量重构** — 自动将 `"string" + var + "string"` 拼接转为 `` `${var}` `` 模板字面量
- **智能注释处理** — 跳过 `//`、`/* */`、`<!-- -->` 注释中的 SQL，避免误转
- **详细报告** — 输出每文件的替换统计和需人工处理的边缘情况

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/love2506755096-maker/oracle-to-mysql-migration.git
cd oracle-to-mysql-migration

# 转换单个文件
node scripts/index.js --target /path/to/result.html

# 转换整个目录（递归扫描 .html 文件）
node scripts/index.js --target /path/to/module/
```

## 自动转换规则

工具按以下顺序执行（顺序很重要）：

| 步骤 | 说明 | 示例 |
|------|------|------|
| 1 | 简单关键词替换 | `NVL(` → `IFNULL(`、`SUBSTR(` → `SUBSTRING(` |
| 2 | 模式替换 | `rownum` → `ROW_NUMBER() OVER()`、`TRUNC(NOW())` → `DATE(NOW())` |
| 3 | TO_CHAR → DATE_FORMAT | `TO_CHAR(dt, 'YYYY-MM-DD')` → `DATE_FORMAT(dt, '%Y-%m-%d')` |
| 4 | TO_CHAR(number) → CAST | `TO_CHAR(123)` → `CAST(123 AS CHAR)` |
| 5 | TO_DATE → STR_TO_DATE | `TO_DATE(str, 'YYYYMMDD')` → `STR_TO_DATE(str, '%Y%m%d')` |
| 6 | INSTR → LOCATE | `INSTR(str, sub)` → `LOCATE(sub, str)`（参数反转） |
| 7 | TO_NUMBER → CAST | `TO_NUMBER(expr)` → `CAST(expr AS DECIMAL)` |
| 8 | ADD_MONTHS → DATE_ADD | `ADD_MONTHS(dt, 3)` → `DATE_ADD(dt, INTERVAL 3 MONTH)` |
| 9 | MONTHS_BETWEEN → TIMESTAMPDIFF | `MONTHS_BETWEEN(d1, d2)` → `TIMESTAMPDIFF(MONTH, d2, d1)` |
| 10 | 模板字面量重构 | `"col=" + var + ","` → `` `col=${var},` `` |
| 11 | DECODE → CASE WHEN | `DECODE(x, 1, 'A', 2, 'B', 'C')` → `CASE WHEN x=1 THEN 'A' ...` |
| 12 | PIVOT → CASE WHEN | `PIVOT(SUM(col) FOR key IN ('v1' C1))` → `SUM(CASE WHEN ...)` |
| 13 | \|\| → CONCAT | `'a'\|\|expr\|\|'b'` → `CONCAT('a', expr, 'b')` |

### 完整对照表

| Oracle | MySQL | 方式 |
|--------|-------|------|
| `NVL(` | `IFNULL(` | 简单替换 |
| `NVL2(` | `IF(` | 简单替换 |
| `SUBSTR(` | `SUBSTRING(` | 简单替换 |
| `LENGTH(` | `CHAR_LENGTH(` | 简单替换 |
| `LENGTHB(` | `LENGTH(` | 简单替换 |
| `SYSDATE` | `NOW()` | 简单替换 |
| `sys_guid()` | `REPLACE(UUID(), '-', '')` | 简单替换 |
| `select rownum rn` | `select ROW_NUMBER() OVER() AS rn` | 模式替换 |
| `AND ROWNUM = 1` | `LIMIT 1` | 模式替换 |
| `ORDER BY col NULLS FIRST` | `ORDER BY col`（删除） | 正则替换 |
| `TO_CHAR(expr, 'format')` | `DATE_FORMAT(expr, '%format')` | 结构化替换 |
| `TO_DATE(str, 'format')` | `STR_TO_DATE(str, '%format')` | 结构化替换 |
| `INSTR(str, substr)` | `LOCATE(substr, str)` | 参数反转 |
| `TO_NUMBER(expr)` | `CAST(expr AS DECIMAL)` | 结构化替换 |
| `ADD_MONTHS(date, N)` | `DATE_ADD(date, INTERVAL N MONTH)` | 结构化替换 |
| `MONTHS_BETWEEN(d1, d2)` | `TIMESTAMPDIFF(MONTH, d2, d1)` | 参数反转 |
| `DECODE(expr, s1, r1, ...)` | `CASE WHEN expr=s1 THEN r1 ... END` | DECODE 转换 |
| `PIVOT(SUM(col) ...)` | `SUM(CASE WHEN ... END)` | PIVOT 转换 |
| `\|\|` | `CONCAT()` | 字符串拼接 |
| `" + var + "` | `` `${var}` `` | 模板字面量（SQL片段变量除外） |
| `(+)` | `(+)` | **保留原样** |

## 输出报告

工具在 `scripts/preprocess-report.json` 生成报告：

```json
{
  "processedFiles": [
    {
      "file": "result.html",
      "simpleReplacements": 149,
      "toCharConversions": 24,
      "decodeConversions": 19,
      "templateLiteralConverted": 4,
      "templateLiteralFailed": [],
      "complexPatterns": []
    }
  ]
}
```

- `templateLiteralFailed` — 无法自动转换的模板字面量块，需人工处理
- `complexPatterns` — 需人工处理的复杂 Oracle 模式（LISTAGG、MERGE INTO、CONNECT BY 等）

## 需要人工处理的边缘情况

| 模式 | MySQL 等价写法 |
|------|---------------|
| `LISTAGG(col, ',') WITHIN GROUP (ORDER BY col)` | `GROUP_CONCAT(col ORDER BY col SEPARATOR ',')` |
| `MERGE INTO ...` | `INSERT INTO ... ON DUPLICATE KEY UPDATE ...` |
| `CONNECT BY PRIOR ...` | `WITH RECURSIVE cte AS (...)` |
| `MINUS` | `NOT EXISTS` |
| ROWNUM 分页 | 嵌套子查询 + `LIMIT` |

## 设计约束

1. **保留 `(+)` 原样** — 不转换为 LEFT/RIGHT JOIN（由上层框架处理）
2. **仅修改 `.html` 文件** — 不修改 `.fpd` 源文件
3. **跳过注释中的 SQL** — `//`、`/* */`、`<!-- -->` 注释内的 SQL 不转换
4. **模板字面量优先** — 先重构模板字面量，再处理 `||`→CONCAT，避免 SQL 内部 `||` 被误转
5. **保护 JS 方法** — 简单替换使用 `(?<!\.)` 负向回顾，避免将 `variable.substr()` 等 JS 方法误转为 SQL 函数
6. **支持表达式模板** — 模板字面量重构支持 `" + (expr) + "` 模式（含嵌套括号）
7. **模板字面量闭合** — backtick 行后有续行时，block 结束前自动闭合 pending 的模板字面量
8. **SQL 片段变量检测** — `str_where*`、`lbxz` 等已知含引号的变量保持 `` ` + var + ` `` 拼接，不嵌入模板字面量
9. **跨行属性访问续行** — `parent.gpm` 被拆到两行（下一行以 `.cxtj` 开头）时自动识别为续行

## 项目结构

```
oracle-to-mysql-migration/
├── README.md
├── SKILL.md              # Claude Code 技能定义
├── scripts/
│   ├── index.js          # 主转换工具
│   └── preprocess-report.json  # 输出报告（自动生成）
└── references/
    └── migration-rules.md  # 完整迁移规则参考
```

## 许可证

内部项目，仅供决策一体化国产化前端改造项目使用。
