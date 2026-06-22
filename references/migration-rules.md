# Oracle 到 MySQL 迁移规则（44 条规则）

## 目录

1. [字符串操作（规则 1、30-33）](#字符串操作)
2. [空值处理（规则 2、34-35）](#空值处理)
3. [外连接（规则 3-4）](#外连接)
4. [行限制与分页（规则 5-7）](#行限制与分页)
5. [日期函数（规则 11-23）](#日期函数)
6. [日期格式化（规则 24-29）](#日期格式化)
7. [数字格式化（规则 10）](#数字格式化)
8. [特殊转换（规则 8-9、36）](#特殊转换)
9. [数字转字符串（规则 39）](#数字转字符串规则-39)
10. [排序空值处理（规则 40-41）](#排序空值处理规则-40-41)
11. [集合差集（规则 42）](#集合差集规则-42)
12. [层次查询（规则 43）](#层次查询规则-43)
13. [主键函数（规则 44）](#主键函数规则-44)

---

## 字符串操作

### 规则 1：字符串拼接

| | |
|---|---|
| Oracle | `\|\|` |
| MySQL | `CONCAT()` |

**模式：** 用 `CONCAT(` 和 `)` 包裹，将 `\|\|` 替换为 `,`

```sql
-- Oracle
SELECT a \|\| '-' \|\| b FROM t;
-- MySQL
SELECT CONCAT(a, '-', b) FROM t;
```

### 规则 30：字符串字符长度

| | |
|---|---|
| Oracle | `LENGTH(str)` |
| MySQL | `CHAR_LENGTH(str)` |

### 规则 31：字符串字节长度

| | |
|---|---|
| Oracle | `LENGTHB(str)` |
| MySQL | `LENGTH(str)` |

> 注意：在 MySQL 中，`LENGTH()` 返回字节长度；`CHAR_LENGTH()` 返回字符长度。

### 规则 32：子字符串

| | |
|---|---|
| Oracle | `SUBSTR(str, start, len)` |
| MySQL | `SUBSTRING(str, start, len)` |

### 规则 33：字符串位置

| | |
|---|---|
| Oracle | `INSTR(str, substr)` |
| MySQL | `LOCATE(substr, str)` |

> **参数顺序相反！** Oracle：先 haystack；MySQL：先 needle。

---

## 空值处理

### 规则 2：NVL

| | |
|---|---|
| Oracle | `NVL(expr, default)` |
| MySQL | `IFNULL(expr, default)` |

### 规则 34：DECODE

| | |
|---|---|
| Oracle | `DECODE(expr, search1, result1, search2, result2, default)` |
| MySQL | `CASE WHEN expr=search1 THEN result1 WHEN expr=search2 THEN result2 ELSE default END` |

### 规则 35：NVL2

| | |
|---|---|
| Oracle | `NVL2(expr, not_null_val, null_val)` |
| MySQL | `IF(expr IS NOT NULL, not_null_val, null_val)` |

---

## 外连接

> ⚠️⚠️⚠️ **【最高优先级·必须遵守】** ⚠️⚠️⚠️
> 
> **`(+)` 运算符必须原样保留，绝对不能转换！**
> 
> - 不要将 `(+)` 转换为 `LEFT JOIN` 或 `RIGHT JOIN`
> - 不要将 `(+)` 转换为 `JOIN ... ON`
> - 保留 `(+)` 在原来的位置，不做任何修改
> 
> **但是**，同一 SQL 中的其他 Oracle 模式（NVL、DECODE、TO_CHAR、||、ROWNUM 等）**仍需正常转换**。
> 切勿因 SQL 包含 `(+)` 就跳过整段 SQL。

### 规则 3：左连接（仅供参考，实际不转换）

| | |
|---|---|
| Oracle | `WHERE a.id(+) = b.id` |
| MySQL | `FROM b LEFT JOIN a ON a.id = b.id` |

> **注意：此规则仅供参考，实际项目中 `(+)` 必须保留原样。**

### 规则 4：右连接（仅供参考，实际不转换）

| | |
|---|---|
| Oracle | `WHERE a.id = b.id(+)` |
| MySQL | `FROM a RIGHT JOIN b ON a.id = b.id` |

> **注意：此规则仅供参考，实际项目中 `(+)` 必须保留原样。**

---

## 行限制与分页

### 规则 5：行号列

| | |
|---|---|
| Oracle | `SELECT ROWNUM rn, ...` |
| MySQL | `SELECT ROW_NUMBER() OVER() AS rn, ...` |

### 规则 6：限制行数

| | |
|---|---|
| Oracle | `WHERE ROWNUM = 1` |
| MySQL | `LIMIT 1` |

### 规则 7：分页查询

| | |
|---|---|
| Oracle | 嵌套 ROWNUM 的子查询 |
| MySQL | `LIMIT offset, count` |

```sql
-- Oracle（分页：第 2 页，每页 10 行）
SELECT * FROM (
  SELECT ROWNUM rn, t.* FROM (
    SELECT * FROM emp ORDER BY id
  ) t WHERE ROWNUM <= 20
) WHERE rn > 10;

-- MySQL
SELECT * FROM emp ORDER BY id LIMIT 10, 10;
```

---

## 日期函数

### 规则 11：日期截断（天）

| | |
|---|---|
| Oracle | `TRUNC(SYSDATE)` |
| MySQL | `DATE(NOW())` |

### 规则 12：日期截断（年）

| | |
|---|---|
| Oracle | `TRUNC(SYSDATE, 'YYYY')` |
| MySQL | `MAKEDATE(YEAR(NOW()), 1)` |

### 规则 13：当前时间戳

| | |
|---|---|
| Oracle | `SYSDATE` |
| MySQL | `NOW()` |

### 规则 14：加 1 天

| | |
|---|---|
| Oracle | `SYSDATE + 1` |
| MySQL | `DATE_ADD(NOW(), INTERVAL 1 DAY)` |

### 规则 15：加 1 个月

| | |
|---|---|
| Oracle | `ADD_MONTHS(SYSDATE, 1)` |
| MySQL | `DATE_ADD(NOW(), INTERVAL 1 MONTH)` |

### 规则 16：加 1 年

| | |
|---|---|
| Oracle | `ADD_MONTHS(SYSDATE, 12)` |
| MySQL | `DATE_ADD(NOW(), INTERVAL 1 YEAR)` |

### 规则 17：减 1 天

| | |
|---|---|
| Oracle | `SYSDATE - 1` |
| MySQL | `DATE_SUB(NOW(), INTERVAL 1 DAY)` |

### 规则 18：减 1 个月

| | |
|---|---|
| Oracle | `ADD_MONTHS(SYSDATE, -1)` |
| MySQL | `DATE_SUB(NOW(), INTERVAL 1 MONTH)` |

### 规则 19：减 2 个月

| | |
|---|---|
| Oracle | `ADD_MONTHS(SYSDATE, -2)` |
| MySQL | `DATE_SUB(NOW(), INTERVAL 2 MONTH)` |

### 规则 20：减 120 个月

| | |
|---|---|
| Oracle | `ADD_MONTHS(SYSDATE, -120)` |
| MySQL | `DATE_SUB(NOW(), INTERVAL 120 MONTH)` |

### 规则 21：减 1 年

| | |
|---|---|
| Oracle | `ADD_MONTHS(SYSDATE, -12)` |
| MySQL | `DATE_SUB(NOW(), INTERVAL 1 YEAR)` |

### 规则 22：日期差（天）

| | |
|---|---|
| Oracle | `date1 - date2` |
| MySQL | `DATEDIFF(date1, date2)` |

### 规则 23：日期差（月）

| | |
|---|---|
| Oracle | `MONTHS_BETWEEN(late_date, early_date)` |
| MySQL | `TIMESTAMPDIFF(MONTH, early_date, late_date)` |

**转换步骤：**
1. **函数替换：** `MONTHS_BETWEEN` → `TIMESTAMPDIFF`
2. **添加参数：** 在第一个参数位置插入 `MONTH`
3. **参数顺序交换：** Oracle：`(late_date, early_date)` → MySQL：`(MONTH, early_date, late_date)`
4. **比较运算符调整：** 如果 `MONTHS_BETWEEN(...)` 前面有 `<`，将 `<` 改为 `<=`（因为 Oracle 返回小数，MySQL 返回整数）

```sql
-- Oracle
WHERE MONTHS_BETWEEN(SYSDATE, create_date) < 12
-- MySQL
WHERE TIMESTAMPDIFF(MONTH, create_date, NOW()) <= 12

-- Oracle
WHERE MONTHS_BETWEEN(SYSDATE, create_date) > 6
-- MySQL
WHERE TIMESTAMPDIFF(MONTH, create_date, NOW()) > 6
```

> **参数顺序相反！** Oracle：较晚日期在前；MySQL：较早日期在前。

---

## 日期格式化

### 规则 24：格式化年

| | |
|---|---|
| Oracle | `TO_CHAR(date, 'YYYY')` |
| MySQL | `DATE_FORMAT(date, '%Y')` |

### 规则 25：格式化年月

| | |
|---|---|
| Oracle | `TO_CHAR(date, 'YYYY-MM')` |
| MySQL | `DATE_FORMAT(date, '%Y-%m')` |

### 规则 26：格式化年月日

| | |
|---|---|
| Oracle | `TO_CHAR(date, 'YYYY-MM-DD')` |
| MySQL | `DATE_FORMAT(date, '%Y-%m-%d')` |

### 规则 27：格式化完整日期时间

| | |
|---|---|
| Oracle | `TO_CHAR(date, 'YYYY-MM-DD HH24:MI:SS')` |
| MySQL | `DATE_FORMAT(date, '%Y-%m-%d %H:%i:%s')` |

### 规则 28：字符串转日期

| | |
|---|---|
| Oracle | `TO_DATE('2024-06-15', 'YYYY-MM-DD')` |
| MySQL | `STR_TO_DATE('2024-06-15', '%Y-%m-%d')` |

### 规则 29：字符串转日期时间

| | |
|---|---|
| Oracle | `TO_DATE('2024-06-15 14:30:00', 'YYYY-MM-DD HH24:MI:SS')` |
| MySQL | `STR_TO_DATE('2024-06-15 14:30:00', '%Y-%m-%d %H:%i:%s')` |

### 格式字符串映射

| Oracle | MySQL | 描述 |
|---|---|---|
| YYYY | %Y | 4 位年份 |
| MM | %m | 2 位月份 |
| DD | %d | 2 位日期 |
| HH24 | %H | 24 小时制 |
| MI | %i | 分钟 |
| SS | %s | 秒 |

---

## 数字格式化

### 规则 10：数字转字符串

| | |
|---|---|
| Oracle | `TO_CHAR(number, 'FM999,999,990.00')` |
| MySQL | `FORMAT(number, 2, 'zh_CN')` |

> Oracle FM 格式中的小数位数决定 MySQL `FORMAT()` 的第二个参数。

---

## 特殊转换

### 规则 8：插入更新（MERGE INTO）

| | |
|---|---|
| Oracle | `MERGE INTO target USING source ON (...) WHEN MATCHED THEN UPDATE ... WHEN NOT MATCHED THEN INSERT ...` |
| MySQL | `INSERT INTO ... ON DUPLICATE KEY UPDATE ...` |

### 规则 9：字符串聚合

| | |
|---|---|
| Oracle | `LISTAGG(col, ',') WITHIN GROUP (ORDER BY col)` |
| MySQL | `GROUP_CONCAT(col ORDER BY col SEPARATOR ',')` |

### 规则 36：序列

| | |
|---|---|
| Oracle | `CREATE SEQUENCE seq_name START WITH 1 INCREMENT BY 1` / `seq_name.NEXTVAL` |
| MySQL | 列定义中的 `AUTO_INCREMENT` |

---

## 行转列（PIVOT）

### 规则 37：PIVOT 转换（工具自动处理）

> ⚠️ **此规则已由工具自动执行**，无需 LLM 手动处理。以下文档仅供理解参考。

| | |
|---|---|
| Oracle | `SELECT * FROM (subquery) PIVOT(agg(value) suffix FOR key IN ('v1','v2','v3'))` |
| MySQL | `SELECT key_col, SUM(CASE WHEN key='v1' THEN value ELSE 0 END) AS "v1_suffix", ... FROM subquery GROUP BY key_col` |

**工具处理方式：**

1. **静态 IN 值**（如 `IN ('v1' C1, 'v2' C2)`）：
   - 直接生成 `SUM(CASE WHEN key='v1' THEN col ELSE 0 END) AS C1_alias` 表达式
   - 替换 PIVOT 行为生成的 CASE WHEN 表达式列表

2. **模板变量 IN**（如 `IN (${swjg_tj})`）：
   - 替换 PIVOT 行为 `${pivotCols}`
   - **需 LLM 手动添加：**
     - `pivotCols` JS 生成代码（在 SQL 查询前）
     - GROUP BY 子句（包含所有非聚合列）

**LLM 添加 `pivotCols` 代码模板：**

```javascript
// 在 swjgArr 循环之后、getHeaderSQL 之前添加
var pivotCols = "";
for (var i = 0; i < swjgArr.length; i++) {
  var colNum = i + 1;
  var val = swjgArr[i].SWJG_DM;
  if (i > 0) pivotCols += ", ";
  pivotCols += "SUM(CASE WHEN SWJG_DM='" + val + "' THEN HS_HJ ELSE 0 END) AS C" + colNum + "_HS";
  pivotCols += ", SUM(CASE WHEN SWJG_DM='" + val + "' THEN JMSE_HJ ELSE 0 END) AS C" + colNum + "_JMSE";
  // ... 其他聚合列
}
```

**SQL 结构模板：**

```sql
-- Oracle
SELECT * FROM (SELECT ... FROM table) PIVOT(SUM(col) alias FOR key IN (${swjg_tj}))

-- MySQL（工具生成 + LLM 补充 GROUP BY）
SELECT ... FROM (
  SELECT T0.col1, T0.col2, ..., ${pivotCols}
  FROM (SELECT ... FROM table) T0
  GROUP BY T0.col1, T0.col2, ...
) T, dimension_table D WHERE ...
```

**转换步骤（手动参考）：**

1. **移除外层包装：** 从 `SELECT * FROM (...) PIVOT(...)` 中提取子查询，直接用作 FROM 子句。

2. **用 CASE 表达式替换 PIVOT：** 对于 IN 列表中的每个值，创建：
   ```sql
   SUM(CASE WHEN pivot_col = 'value' THEN numeric_col ELSE 0 END) AS "value_suffix"
   ```

3. **添加 GROUP BY：** SELECT 中所有未被聚合函数包裹的列都必须添加到 GROUP BY。

**示例：**

```sql
-- Oracle
SELECT *
FROM
    (SELECT uuid
     FROM table_name
     WHERE uuid > 1000
    )
PIVOT(SUM(value_name) HS FOR key_name IN ('01', '02', '03'));

-- MySQL
SELECT uuid,
       SUM(CASE WHEN key_name = '01' THEN value_name ELSE 0 END) AS "01_HS",
       SUM(CASE WHEN key_name = '02' THEN value_name ELSE 0 END) AS "02_HS",
       SUM(CASE WHEN key_name = '03' THEN value_name ELSE 0 END) AS "03_HS"
FROM table_name
WHERE uuid > 1000
GROUP BY uuid;
```

**公式：**
```
PIVOT( SUM(数值) 后缀 FOR 被转列 IN ('值1','值2') )
       ↓
SUM(CASE WHEN 被转列 = '值1' THEN 数值 ELSE 0 END) AS "值1_后缀",
SUM(CASE WHEN 被转列 = '值2' THEN 数值 ELSE 0 END) AS "值2_后缀"
```

**注意事项：**
- 聚合函数后的后缀成为列别名的一部分（例如，`HS` → `"01_HS"`）
- 如果子查询有 WHERE 条件，将其移到外层查询
- 除非在原始子查询的 SELECT 中，否则不会选择 pivot 列本身
- **Oracle 列别名必须使用双引号（`"`），而非单引号（`'`）** — 单引号仅用于字符串字面量，不用于标识符。在 JavaScript 代码中，使用转义双引号：`AS \"C1_HS\"`

---

## 模板字面量重构（规则 38）

### 规则 38：将拼接的 SQL 转换为模板字面量

| | |
|---|---|
| Oracle/JS | 使用 `+` 拼接构建的 SQL 字符串 |
| 现代 JS | 使用反引号 `` ` `` 和 `${variable}` 插值的模板字面量 |

**何时应用：**
- **仅限完整的 SQL 语句**（以 `SELECT` 开头并以适当的 SQL 终止符结尾）
- 使用字符串拼接（`+`）构建的多行 SQL 字符串
- 嵌入 JavaScript 变量的 SQL 字符串

**应用范围：**
- ✅ 应用于：`str_sql = "SELECT ..."`（完整 SQL 语句）
- ✅ 应用于：`var sql = "SELECT ..."`（完整 SQL 语句）
- ❌ 跳过：`fields += " ..."`（部分字符串构建）
- ❌ 跳过：`swjg_tj += "'" + ...`（部分字符串构建）
- ❌ 跳过：标题/头部字符串拼接（非 SQL）

**转换步骤：**

1. **将双引号替换为反引号：** 将 `"..." +` 改为 `` `...` ``
2. **替换变量拼接：** 将 `" + variable + "` 改为 `${variable}`
3. **保留 SQL 字符串字面量：** 保持 SQL 内部用于数据库字符串值的单引号
4. **保持缩进：** 使用适当的换行和缩进以提高可读性

**示例：**

```javascript
// 重构前（拼接）
str_sql = "SELECT IFNULL(IFNULL(B.ZCMC, '&nbsp;'), '&nbsp;') ZCCS, " +
          "       B.ZSXM_MC ZSXM, " +
          "       (case when B.JMXZ_DM ='9' then '--' else null end) as JMXZDM," +
          "       B.JMXMMC JMXZMC, " + fields +
          "  FROM (SELECT SSYF, SSSWJG_DM, ZCBM, ZSXM_DM, JMXZ_DM, " + pivotFields +
          "        FROM " + tjbm + " WHERE ssyf = '" + parent.gpm.cxtj.tjny + "'" +
          "        GROUP BY SSYF, SSSWJG_DM, ZCBM, ZSXM_DM, JMXZ_DM) A," + dmbm + " B " +
          " WHERE A.ZCBM(+) = B.ZCBM " + zsxm_con +
          "   AND A.JMXZ_DM(+) = B.JMXZ_DM " +
          "   AND B.FZTJBM LIKE CONCAT('%', '" + bm + "', '%')" + str_where + parent.gpm.cxtj.zsfs + " ORDER BY B.XH";

// 重构后（模板字面量）
str_sql = `SELECT IFNULL(IFNULL(B.ZCMC, '&nbsp;'), '&nbsp;') ZCCS,
                   B.ZSXM_MC ZSXM,
                   (case when B.JMXZ_DM ='9' then '--' else null end) as JMXZDM,
                   B.JMXMMC JMXZMC, ${fields}
            FROM (SELECT SSYF, SSSWJG_DM, ZCBM, ZSXM_DM, JMXZ_DM, ${pivotFields}
                  FROM ${tjbm} WHERE ssyf = '${parent.gpm.cxtj.tjny}'
                  GROUP BY SSYF, SSSWJG_DM, ZCBM, ZSXM_DM, JMXZ_DM) A, ${dmbm} B
            WHERE A.ZCBM(+) = B.ZCBM ${zsxm_con}
              AND A.JMXZ_DM(+) = B.JMXZ_DM
              AND B.FZTJBM LIKE CONCAT('%', '${bm}', '%') ${str_where} ${parent.gpm.cxtj.zsfs} ORDER BY B.XH`;
```

**规则：**
- 使用反引号（`` ` ``）而非双引号表示多行 SQL 字符串
- 将 `" + variable + "` 替换为 `${variable}`
- 保留 SQL 内部用于字符串字面量的单引号（例如 `'&nbsp;'`、`'9'`）
- 保留 `(+)` 运算符原样不变 — 不转换外连接语法
- 保持适当的缩进以提高可读性

**优势：**
- 更好的可读性 — 不再有分散的引号和加号
- 更易维护 — SQL 结构清晰可见
- 更少出错 — 不会遗漏引号或拼接运算符

---

## 数字转字符串（规则 39）

### 规则 39：数字转字符串

| | |
|---|---|
| Oracle | `TO_CHAR(number)` |
| MySQL | `CAST(number AS CHAR)` |

**转换步骤：**

1. **函数替换：** `TO_CHAR(` → `CAST(`
2. **添加类型后缀：** 在参数后添加 ` AS CHAR)`

```sql
-- Oracle
SELECT TO_CHAR(4565765.6787689) FROM dual;

-- MySQL
SELECT CAST(4565765.6787689 AS CHAR) FROM dual;
```

> **注意：** 规则 10（数字格式化 `TO_CHAR(number, 'FM999,999,990.00')` → `FORMAT(number, 2)`）优先级更高。仅当 `TO_CHAR` 无格式化字符串参数时使用本规则。

---

## 排序空值处理（规则 40-41）

### 规则 40：NULLS FIRST 排序

| | |
|---|---|
| Oracle | `ORDER BY col NULLS FIRST` |
| MySQL | `ORDER BY ISNULL(col) DESC, col` |

**原理：** MySQL 中 `ISNULL(col)` 返回 1（是 NULL）或 0（非 NULL）。`DESC` 排序使 NULL 值（1）排在前面。

```sql
-- Oracle
SELECT * FROM t ORDER BY LRR_DM NULLS FIRST;

-- MySQL
SELECT * FROM t ORDER BY ISNULL(LRR_DM) DESC, LRR_DM;
```

### 规则 41：NULLS LAST 排序

| | |
|---|---|
| Oracle | `ORDER BY col NULLS LAST` |
| MySQL | `ORDER BY ISNULL(col), col` |

**原理：** `ISNULL(col)` 默认 ASC 排序使非 NULL 值（0）排在前面，NULL 值（1）排在最后。

```sql
-- Oracle
SELECT * FROM t ORDER BY LRR_DM NULLS LAST;

-- MySQL
SELECT * FROM t ORDER BY ISNULL(LRR_DM), LRR_DM;
```

> **注意：** 如果原排序已有 DESC，需保留：`ORDER BY ISNULL(col), col DESC`。

---

## 集合差集（规则 42）

### 规则 42：MINUS 差集

| | |
|---|---|
| Oracle | `SELECT ... FROM A MINUS SELECT ... FROM B` |
| MySQL | `SELECT ... FROM A WHERE NOT EXISTS (SELECT 1 FROM B WHERE B.key = A.key AND ...)` |

**背景：** MySQL 不支持 `MINUS` 关键字。MySQL 8.0.31+ 支持 `EXCEPT`，但为兼容更低版本，推荐使用 `NOT EXISTS` 改写。

**转换步骤：**

1. **提取两个查询的关联列：** 找到两个 SELECT 中对应的列（通常是主键或唯一键）
2. **改写为 NOT EXISTS：** 将第二个查询改为子查询，用关联条件连接
3. **添加关联条件：** `WHERE B.key = A.key AND ...`

```sql
-- Oracle
SELECT uuid, name FROM table_a
MINUS
SELECT uuid, name FROM table_b;

-- MySQL
SELECT uuid, name FROM table_a A
WHERE NOT EXISTS (
  SELECT 1 FROM table_b B
  WHERE B.uuid = A.uuid AND B.name = A.name
);
```

> **注意：** `MINUS` 自动去重，`NOT EXISTS` 也天然去重。如果确认无重复且 MySQL 版本 ≥ 8.0.31，可直接用 `EXCEPT` 替代。

---

## 层次查询（规则 43）

### 规则 43：CONNECT BY 层次查询

| | |
|---|---|
| Oracle | `SELECT LEVEL, col FROM t START WITH ... CONNECT BY PRIOR child = parent` |
| MySQL | `WITH RECURSIVE cte AS (锚点 UNION ALL 递归) SELECT * FROM cte` |

**转换步骤：**

1. **拆子查询：** Oracle 中 `FROM (...)` 子查询的内容提出来作为 CTE 锚点的数据源
2. **START WITH → 锚点 WHERE：** `START WITH JD_DM = '0'` 直接转为锚点 `WHERE JD_DM = '0'`
3. **CONNECT BY PRIOR child = parent → 递归 INNER JOIN：** `PRIOR JD_DM = FJD_DM` 转为递归部分的 `ON t.JD_DM = t2.FJD_DM`
4. **LEVEL → 计数器：** 锚点 `1 AS LEVEL`，递归部分 `t.LEVEL + 1`
5. **外层 SELECT：** 保持原样 `SELECT LEVEL, JD_DM FROM tree`，确保列名与 Oracle 一致

```sql
-- Oracle
SELECT LEVEL, JD_DM FROM QX_GNMK_TREE
  START WITH JD_DM = '0'
  CONNECT BY PRIOR JD_DM = FJD_DM;

-- MySQL
WITH RECURSIVE tree AS (
  SELECT 1 AS LEVEL, JD_DM
    FROM QX_GNMK_TREE
   WHERE JD_DM = '0'
  UNION ALL
  SELECT t.LEVEL + 1, t2.JD_DM
    FROM QX_GNMK_TREE t2
    INNER JOIN tree t ON t.JD_DM = t2.FJD_DM
)
SELECT LEVEL, JD_DM FROM tree;
```

> **注意：**
> - 如果 Oracle 原查询有 `ORDER SIBLINGS BY`，MySQL 递归 CTE 中无法直接实现，需在外层 SELECT 加 `ORDER BY`
> - `LEVEL` 是 Oracle 保留字，MySQL CTE 中用作列名需确保不冲突
> - 递归深度默认无限制，如需限制可设置 `cte_max_recursion_depth`

---

## 主键函数（规则 44）

### 规则 44：sys_guid 主键函数

| | |
|---|---|
| Oracle | `sys_guid()` |
| MySQL | `REPLACE(UUID(), '-', '')` |

**处理方式：** 脚本自动修改（完全替换）

**说明：** Oracle `sys_guid()` 生成 32 位无连字符的十六进制字符串。MySQL `UUID()` 生成带连字符的 36 位字符串，需用 `REPLACE(UUID(), '-', '')` 去掉连字符以保持格式一致。

```sql
-- Oracle
SELECT sys_guid() FROM dual;

-- MySQL
SELECT REPLACE(UUID(), '-', '') FROM dual;
```
