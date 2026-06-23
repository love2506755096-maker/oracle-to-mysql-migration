#!/usr/bin/env node

/**
 * Oracle-to-MySQL 预处理工具
 *
 * 功能：
 *   1. 自动替换简单关键词（NVL→IFNULL, SUBSTR→SUBSTRING 等）
 *   2. 自动将 SQL || 拼接转换为 CONCAT()
 *   3. 自动重构简单模板字面量（单行、少量变量拼接）
 *   4. 提取复杂 SQL 拼接块供 LLM 重构模板字面量
 *   5. 标记需 LLM 处理的复杂 Oracle 模式（DECODE, TO_CHAR, PIVOT 等）
 *
 * 用法：node index.js --target <目录或文件>
 */

const fs = require('fs');
const path = require('path');

// ==================== CLI ====================

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { target: null, config: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) result.target = args[++i];
    else if (args[i] === '--config' && args[i + 1]) result.config = args[++i];
  }
  if (!result.target) {
    console.error('用法: node index.js --target <目录或文件> [--config <配置文件>]');
    process.exit(1);
  }
  return result;
}

// ==================== 工具函数 ====================

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath || path.join(__dirname, 'config.json'), 'utf-8'));
}

function loadKeywords(keywordsConfigPath) {
  if (!fs.existsSync(keywordsConfigPath)) return [];
  return fs.readFileSync(keywordsConfigPath, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && l !== '||');
}

function scanFiles(targetPath) {
  // 如果是 .fpd 文件路径，自动转换为对应的 .html 文件路径
  // 用户输入如 sgs/xwqy/.../top.fpd → 实际查找 views/bi/sgs/xwqy/.../top.html
  if (targetPath.endsWith('.fpd')) {
    // 自动加上 views/bi/ 前缀（如果用户没有加）
    let htmlPath = targetPath.replace(/\.fpd$/, '.html');
    if (!htmlPath.startsWith('views/bi/') && !htmlPath.startsWith('views\\bi\\')) {
      htmlPath = path.join('views', 'bi', htmlPath);
    }
    if (fs.existsSync(htmlPath)) return [htmlPath];
    // 不存在也返回，让后续报错更清晰
    return [htmlPath];
  }
  // 目录路径也自动加 views/bi/ 前缀
  if (!targetPath.startsWith('views/bi/') && !targetPath.startsWith('views\\bi\\') &&
      !path.isAbsolute(targetPath)) {
    targetPath = path.join('views', 'bi', targetPath);
  }
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) return [targetPath];
  const files = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (f.endsWith('.html')) files.push(fp);
    }
  })(targetPath);
  return files;
}

function countMatches(str, pattern) {
  let count = 0, m;
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  while ((m = re.exec(str)) !== null) count++;
  return count;
}

// ==================== 注释检测 ====================

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--');
}

// ==================== 简单关键词替换 ====================

function simpleReplace(content, config) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line)) return line;
    let modified = line;
    for (const [from, to] of Object.entries(config.simpleReplacements || {})) {
      // 添加 (?<!\.) 负向回顾，避免匹配 JavaScript 方法调用（如 variable.substr()）
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?<!\\.)' + escaped, 'gi');
      const matches = modified.match(re);
      if (matches) { count += matches.length; modified = modified.replace(re, to); }
    }
    for (const [from, to] of Object.entries(config.exactReplacements || {})) {
      const re = new RegExp('\\b' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      const matches = modified.match(re);
      if (matches) {
        count += matches.length;
        modified = modified.replace(re, to).replace(/  +/g, ' ').replace(/ ;/g, ';');
      }
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

// ==================== 模式替换（固定正则模式） ====================

function patternReplace(content, config) {
  let count = 0;
  let modified = content;

  // 固定字符串替换
  for (const p of config.patternReplacements || []) {
    const lines = modified.split('\n');
    const result = lines.map(line => {
      if (isCommentLine(line)) return line;
      if (!line.includes(p.find)) return line;
      const n = (line.split(p.find).length - 1);
      count += n;
      return line.split(p.find).join(p.replace);
    });
    modified = result.join('\n');
  }

  // 正则替换（简单模式）
  for (const p of config.regexReplacements || []) {
    const re = new RegExp(p.pattern, 'g');
    const lines = modified.split('\n');
    const result = lines.map(line => {
      if (isCommentLine(line)) return line;
      const matches = line.match(re);
      if (!matches) return line;
      count += matches.length;
      return line.replace(re, p.replace);
    });
    modified = result.join('\n');
  }

  // 结构化替换：TO_CHAR(ROUND(IFNULL(...), 2)) → CAST(ROUND(IFNULL(...), 2) AS CHAR)
  // 需要正确处理嵌套括号
  const lines = modified.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line)) return line;
    if (!line.includes('TO_CHAR(ROUND(IFNULL(')) return line;
    let n = 0;
    let out = '';
    let i = 0;
    while (i < line.length) {
      const rest = line.substring(i);
      if (rest.startsWith('TO_CHAR(ROUND(IFNULL(')) {
        // 找到匹配的闭合括号
        const start = i;
        i += 'TO_CHAR(ROUND(IFNULL('.length;
        let depth = 3; // TO_CHAR( + ROUND( + IFNULL(
        while (i < line.length && depth > 0) {
          if (line[i] === '(') depth++;
          else if (line[i] === ')') depth--;
          i++;
        }
        // 现在 i 指向 TO_CHAR 闭合括号之后
        out += 'CAST(ROUND(IFNULL(' + line.substring(start + 'TO_CHAR(ROUND(IFNULL('.length, i - 1) + ' AS CHAR)';
        n++;
      } else {
        out += line[i];
        i++;
      }
    }
    if (n > 0) { count += n; return out; }
    return line;
  });
  modified = result.join('\n');

  return { content: modified, count };
}

// ==================== TO_CHAR → DATE_FORMAT / CAST ====================

/**
 * 查找与开括号位置匹配的闭合括号位置
 */
function findClosingParen(str, openPos) {
  let depth = 0;
  for (let k = openPos; k < str.length; k++) {
    if (str[k] === '(') depth++;
    else if (str[k] === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Oracle TO_CHAR(date, 'format') → MySQL DATE_FORMAT(date, '%format')
 * 格式映射：YYYY→%Y, MM→%m, DD→%d, HH24→%H, MI→%i, SS→%s, YY→%y
 */
function convertToChar(content) {
  const oracleToMysql = { 'YYYY': '%Y', 'YY': '%y', 'MM': '%m', 'DD': '%d', 'HH24': '%H', 'MI': '%i', 'SS': '%s' };
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !/TO_CHAR\(/i.test(line)) return line;
    let modified = line;
    // 循环处理一行中的多个 TO_CHAR
    for (let iter = 0; iter < 10; iter++) {
      const idx = modified.toUpperCase().indexOf('TO_CHAR(');
      if (idx === -1) break;
      // 找到匹配的闭合括号
      const end = findClosingParen(modified, idx + 7);
      if (end === -1) break;
      const inner = modified.substring(idx + 8, end);
      // 找到最后一个逗号的位置（分离表达式和格式字符串）
      let lastComma = -1, d = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === '(') d++;
        else if (inner[k] === ')') d--;
        else if (inner[k] === ',' && d === 0) lastComma = k;
      }
      if (lastComma === -1) break;
      const expr = inner.substring(0, lastComma).trim();
      const fmtRaw = inner.substring(lastComma + 1).trim();
      // 检查是否是带格式字符串的 TO_CHAR：'format'
      const fmtMatch = fmtRaw.match(/^'([^']+)'$/);
      if (!fmtMatch) break;
      // 转换格式字符串
      let fmt = fmtMatch[1];
      for (const [ora, my] of Object.entries(oracleToMysql)) {
        fmt = fmt.replace(new RegExp(ora, 'gi'), my);
      }
      const replacement = `DATE_FORMAT(${expr}, '${fmt}')`;
      modified = modified.substring(0, idx) + replacement + modified.substring(end + 1);
      count++;
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

/**
 * Oracle TO_CHAR(number) → MySQL CAST(number AS CHAR)
 * 处理数字转字符串场景（没有格式字符串参数）
 */
function convertToCharForNumber(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !/to_char\(/i.test(line)) return line;
    let modified = line;
    // 循环处理一行中的多个 to_char
    for (let iter = 0; iter < 20; iter++) {
      const idx = modified.toUpperCase().indexOf('TO_CHAR(');
      if (idx === -1) break;
      // 找到匹配的闭合括号
      const end = findClosingParen(modified, idx + 7);
      if (end === -1) break;
      const inner = modified.substring(idx + 8, end);
      // 检查是否有逗号（区分 TO_CHAR(expr, 'format') 和 TO_CHAR(expr)）
      let hasComma = false, d = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === '(') d++;
        else if (inner[k] === ')') d--;
        else if (inner[k] === ',' && d === 0) { hasComma = true; break; }
      }
      // 如果有逗号，跳过（由 convertToChar 处理）
      if (hasComma) break;
      // 转换：TO_CHAR(expr) → CAST(expr AS CHAR)
      const replacement = `CAST(${inner} AS CHAR)`;
      modified = modified.substring(0, idx) + replacement + modified.substring(end + 1);
      count++;
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

// ==================== TO_DATE → STR_TO_DATE ====================

/**
 * Oracle TO_DATE('string', 'format') → MySQL STR_TO_DATE('string', '%format')
 * 复用 convertToChar 的格式映射表
 */
function convertToDate(content) {
  const oracleToMysql = { 'YYYY': '%Y', 'YY': '%y', 'MM': '%m', 'DD': '%d', 'HH24': '%H', 'MI': '%i', 'SS': '%s' };
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !/TO_DATE\(/i.test(line)) return line;
    let modified = line;
    for (let iter = 0; iter < 10; iter++) {
      const idx = modified.toUpperCase().indexOf('TO_DATE(');
      if (idx === -1) break;
      const end = findClosingParen(modified, idx + 7);
      if (end === -1) break;
      const inner = modified.substring(idx + 8, end);
      // 找最后一个逗号（分离表达式和格式字符串）
      let lastComma = -1, d = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === '(') d++;
        else if (inner[k] === ')') d--;
        else if (inner[k] === ',' && d === 0) lastComma = k;
      }
      if (lastComma === -1) break;
      const expr = inner.substring(0, lastComma).trim();
      const fmtRaw = inner.substring(lastComma + 1).trim();
      const fmtMatch = fmtRaw.match(/^'([^']+)'$/);
      if (!fmtMatch) break;
      let fmt = fmtMatch[1];
      for (const [ora, my] of Object.entries(oracleToMysql)) {
        fmt = fmt.replace(new RegExp(ora, 'gi'), my);
      }
      const replacement = `STR_TO_DATE(${expr}, '${fmt}')`;
      modified = modified.substring(0, idx) + replacement + modified.substring(end + 1);
      count++;
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

// ==================== INSTR → LOCATE ====================

/**
 * Oracle INSTR(str, substr) → MySQL LOCATE(substr, str)
 * 参数顺序反转
 */
function convertInstr(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !/INSTR\(/i.test(line)) return line;
    let modified = line;
    for (let iter = 0; iter < 10; iter++) {
      const idx = modified.toUpperCase().indexOf('INSTR(');
      if (idx === -1) break;
      const end = findClosingParen(modified, idx + 5);
      if (end === -1) break;
      const inner = modified.substring(idx + 6, end);
      // 分割两个参数（处理嵌套括号）
      let commaIdx = -1, d = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === '(') d++;
        else if (inner[k] === ')') d--;
        else if (inner[k] === ',' && d === 0) { commaIdx = k; break; }
      }
      if (commaIdx === -1) break;
      const str = inner.substring(0, commaIdx).trim();
      const substr = inner.substring(commaIdx + 1).trim();
      const replacement = `LOCATE(${substr}, ${str})`;
      modified = modified.substring(0, idx) + replacement + modified.substring(end + 1);
      count++;
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

// ==================== TO_NUMBER → CAST(AS DECIMAL) ====================

/**
 * Oracle TO_NUMBER(expr) → MySQL CAST(expr AS DECIMAL)
 */
function convertToNumber(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !/TO_NUMBER\(/i.test(line)) return line;
    let modified = line;
    for (let iter = 0; iter < 10; iter++) {
      const idx = modified.toUpperCase().indexOf('TO_NUMBER(');
      if (idx === -1) break;
      const end = findClosingParen(modified, idx + 9);
      if (end === -1) break;
      const inner = modified.substring(idx + 10, end);
      const replacement = `CAST(${inner} AS DECIMAL)`;
      modified = modified.substring(0, idx) + replacement + modified.substring(end + 1);
      count++;
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

// ==================== ADD_MONTHS → DATE_ADD/DATE_SUB ====================

/**
 * Oracle ADD_MONTHS(date, N) → MySQL DATE_ADD(date, INTERVAL N MONTH)
 * 负数 N 自动转为 DATE_SUB
 */
function convertAddMonths(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !/ADD_MONTHS\(/i.test(line)) return line;
    let modified = line;
    for (let iter = 0; iter < 10; iter++) {
      const idx = modified.toUpperCase().indexOf('ADD_MONTHS(');
      if (idx === -1) break;
      const end = findClosingParen(modified, idx + 10);
      if (end === -1) break;
      const inner = modified.substring(idx + 11, end);
      // 分割两个参数
      let commaIdx = -1, d = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === '(') d++;
        else if (inner[k] === ')') d--;
        else if (inner[k] === ',' && d === 0) { commaIdx = k; break; }
      }
      if (commaIdx === -1) break;
      const dateExpr = inner.substring(0, commaIdx).trim();
      const months = inner.substring(commaIdx + 1).trim();
      // 判断正负：字面量负数用 DATE_SUB，其他用 DATE_ADD
      const isNegative = /^-\s*\d+$/.test(months);
      let replacement;
      if (isNegative) {
        replacement = `DATE_SUB(${dateExpr}, INTERVAL ${months.replace(/^-/, '')} MONTH)`;
      } else {
        replacement = `DATE_ADD(${dateExpr}, INTERVAL ${months} MONTH)`;
      }
      modified = modified.substring(0, idx) + replacement + modified.substring(end + 1);
      count++;
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

// ==================== MONTHS_BETWEEN → TIMESTAMPDIFF ====================

/**
 * Oracle MONTHS_BETWEEN(date1, date2) → MySQL TIMESTAMPDIFF(MONTH, date2, date1)
 * 参数顺序反转
 */
function convertMonthsBetween(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !/MONTHS_BETWEEN\(/i.test(line)) return line;
    let modified = line;
    for (let iter = 0; iter < 10; iter++) {
      const idx = modified.toUpperCase().indexOf('MONTHS_BETWEEN(');
      if (idx === -1) break;
      const end = findClosingParen(modified, idx + 14);
      if (end === -1) break;
      const inner = modified.substring(idx + 15, end);
      let commaIdx = -1, d = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === '(') d++;
        else if (inner[k] === ')') d--;
        else if (inner[k] === ',' && d === 0) { commaIdx = k; break; }
      }
      if (commaIdx === -1) break;
      const date1 = inner.substring(0, commaIdx).trim();
      const date2 = inner.substring(commaIdx + 1).trim();
      // 参数反转：MONTHS_BETWEEN(late, early) → TIMESTAMPDIFF(MONTH, early, late)
      const replacement = `TIMESTAMPDIFF(MONTH, ${date2}, ${date1})`;
      modified = modified.substring(0, idx) + replacement + modified.substring(end + 1);
      count++;
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

// ==================== || → CONCAT ====================

/**
 * 将 SQL 中的 || 拼接转换为 CONCAT()
 * 仅处理模板字面量内部的 ||（SQL 内容），不处理 JS 代码中的 ||
 */
function convertConcat(content) {
  let total = 0;
  let inTemplate = false;
  const result = content.split('\n').map(line => {
    // 跟踪模板字面量状态
    const backtickCount = (line.match(/`/g) || []).length;
    if (!inTemplate) {
      if (backtickCount % 2 === 1) inTemplate = true;
      // 模板字面量外部：跳过，不转换 ||（避免误转 JS 逻辑或）
      return line;
    } else {
      if (backtickCount % 2 === 1) inTemplate = false;
      // 模板字面量内部：SQL 内容，需要转换 ||
      if (!line.includes('||')) return line;
    }
    const { converted, count } = convertLineConcat(line);
    total += count;
    return converted;
  });
  return { content: result.join('\n'), count: total };
}

function convertLineConcat(line) {
  const concatRe = /(?:'[^']*'|[A-Za-z_]\w*(?:\.\w+)*(?:\([^)]*\))?|(?:\([^)]*\)))(?:\s*\|\|\s*(?:'[^']*'|[A-Za-z_]\w*(?:\.\w+)*(?:\([^)]*\))?|(?:\([^)]*\))))+/g;
  let count = 0;
  const result = line.replace(concatRe, match => {
    const parts = match.split(/\s*\|\|\s*/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return match;
    count++;
    return `CONCAT(${parts.join(', ')})`;
  });
  return { converted: result, count };
}

/**
 * 修复 CONCAT 内部残留的 || 连接符
 * 场景：CONCAT('text', CAST(... AS CHAR)||'end') → CONCAT('text', CAST(... AS CHAR), 'end')
 * 匹配模式：AS CHAR)||'text' 或 ))||'text'
 */
function fixConcatInternalPipes(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !line.includes('CONCAT(')) return line;
    let modified = line;
    // 匹配：AS CHAR)||'text' 或 ))||'text'（在 CONCAT 调用内部）
    const pipeRe = /(\bAS CHAR\)|\)\))\|\|('[^']*')/g;
    const matches = modified.match(pipeRe);
    if (matches) {
      count += matches.length;
      modified = modified.replace(pipeRe, '$1, $2');
    }
    return modified;
  });
  return { content: result.join('\n'), count };
}

/**
 * 删除 SQL 块中的注释行
 * 处理模板字面量内部的 // 注释，避免注释阻断 SQL 拼接链
 */
function removeSqlBlockComments(content) {
  let count = 0;
  const lines = content.split('\n');
  let inTemplate = false;
  let inBlockComment = false;
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const backtickCount = (line.match(/`/g) || []).length;

    // 跟踪模板字面量状态
    if (!inTemplate) {
      if (backtickCount % 2 === 1) inTemplate = true;
      result.push(line);
      continue;
    }

    // 模板字面量闭合行（含奇数个 backtick）
    if (backtickCount % 2 === 1) {
      inTemplate = false;
      result.push(line);
      // 检查闭合后是否有 /* */ 注释块夹在模板和续行之间
      // 如：` \n /* ... */ \n + "..."
      let peek = i + 1;
      while (peek < lines.length && lines[peek].trim() === '') peek++;
      if (peek < lines.length && lines[peek].trim().startsWith('/*')) {
        // 找到 /* 注释，向前扫描到 */ 之后
        let commentEnd = peek;
        let foundEnd = false;
        while (commentEnd < lines.length) {
          if (lines[commentEnd].includes('*/')) {
            foundEnd = true;
            commentEnd++;
            break;
          }
          commentEnd++;
        }
        if (foundEnd) {
          // 跳过 */ 之后的空行，看下一行是否以 + 开头（SQL 拼接续行）
          let afterComment = commentEnd;
          while (afterComment < lines.length && lines[afterComment].trim() === '') afterComment++;
          if (afterComment < lines.length && lines[afterComment].trim().startsWith('+')) {
            // 确认是 SQL 拼接链中的注释，跳过注释行
            for (let k = i + 1; k < commentEnd; k++) {
              count++;
            }
            i = commentEnd - 1; // -1 因为 for 循环会 i++
          }
        }
      }
      continue;
    }

    // 在模板字面量内部，处理 /* */ 注释
    // 先处理跨行 /* 注释的状态
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx >= 0) {
        inBlockComment = false;
        const after = line.substring(endIdx + 2).trim();
        if (after) {
          result.push(after);
        }
        // 整行是注释内容，跳过
        count++;
        continue;
      }
      // 整行在注释内部，跳过
      count++;
      continue;
    }

    const trimmed = line.trim();

    // 检查 /* 开始的块注释（可能单行或多行）
    if (trimmed.startsWith('/*')) {
      const endIdx = line.indexOf('*/', line.indexOf('/*') + 2);
      if (endIdx >= 0) {
        // 单行 /* ... */ 注释
        const after = line.substring(endIdx + 2).trim();
        if (after) {
          result.push(after);
          count++;
          continue;
        }
        // 整行是注释，跳过
        count++;
        continue;
      }
      // 多行注释开始
      inBlockComment = true;
      count++;
      continue;
    }

    // 检查 // 或 * 开头的注释行
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      count++;
      continue;
    }

    // 剥离行尾 // 注释（保留代码部分）
    if (line.includes('//')) {
      const commentIdx = line.indexOf('//');
      const beforeComment = line.substring(0, commentIdx);
      const singleQuotes = (beforeComment.match(/'/g) || []).length;
      const doubleQuotes = (beforeComment.match(/"/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
        result.push(line.substring(0, commentIdx).trimEnd());
        count++;
        continue;
      }
    }

    result.push(line);
  }

  return { content: result.join('\n'), count };
}

/**
 * 删除所有行中的 // 注释（不限于模板字面量内部）
 * 处理字符串拼接块中的 // 注释，避免注释阻断 SQL 拼接链
 * 跳过 :// (URLs) 和 /// (三斜杠)
 * @param {Set} preserveLines - 需要保留注释的行号集合（非 SQL 块行）
 */
function removeInlineComments(content, preserveLines) {
  let count = 0;
  const lines = content.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 如果该行需要保留注释（非 SQL 块行），跳过
    if (preserveLines && preserveLines.has(i)) {
      result.push(line);
      continue;
    }

    // 纯注释行（以 // 开头）→ 删除整行
    if (trimmed.startsWith('//')) {
      count++;
      continue;
    }

    // 行内 // 注释 → 剥离注释部分
    if (line.includes('//')) {
      // 查找所有 // 位置，从后往前找第一个在引号外部的 //
      const allIdx = [];
      let searchFrom = 0;
      while (true) {
        const idx = line.indexOf('//', searchFrom);
        if (idx === -1) break;
        allIdx.push(idx);
        searchFrom = idx + 2;
      }

      // 从后往前检查，找到第一个在引号外部的 //
      let foundCommentIdx = -1;
      for (let k = allIdx.length - 1; k >= 0; k--) {
        const commentIdx = allIdx[k];
        // 检查 // 前面是否有 : (URL 如 http://) → 不是注释
        if (commentIdx > 0 && line[commentIdx - 1] === ':') continue;
        // 检查是否是 /// (三斜杠) → 不是注释
        if (commentIdx + 2 < line.length && line[commentIdx + 2] === '/') continue;
        // 检查 // 是否在引号内部
        const beforeComment = line.substring(0, commentIdx);
        const singleQuotes = (beforeComment.match(/'/g) || []).length;
        const doubleQuotes = (beforeComment.match(/"/g) || []).length;
        // 偶数引号 → // 在引号外部，是真正的注释
        if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
          foundCommentIdx = commentIdx;
          break;
        }
      }

      if (foundCommentIdx !== -1) {
        result.push(line.substring(0, foundCommentIdx).trimEnd());
        count++;
        continue;
      }
    }

    result.push(line);
  }

  return { content: result.join('\n'), count };
}

// ==================== 模板字面量重构 ====================

function refactorTemplateLiterals(content) {
  const lines = content.split('\n');
  const blocks = findSqlBlocks(lines);
  let offset = 0, count = 0;
  const failedBlocks = [];

  for (const block of blocks) {
    const converted = convertBlockToTemplate(block);
    if (converted) {
      const convertedLines = converted.split('\n');
      lines.splice(block.startIdx + offset, block.lines.length, ...convertedLines);
      offset += convertedLines.length - block.lines.length;
      count++;
    } else {
      // 转换失败，提取给 LLM
      failedBlocks.push({
        varName: block.varName,
        op: block.op,
        startLine: block.startIdx + 1,
        endLine: block.startIdx + block.lines.length,
        lines: block.lines.map(l => l.trimEnd())
      });
    }
  }

  return { content: lines.join('\n'), count, failedBlocks };
}

/**
 * 处理单行 SQL 拼接：var sql = "SELECT ..." + var + "..."
 * 转换为模板字面量：var sql = `SELECT ...${var}...`
 */
function convertSingleLineSql(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line)) return line;
    // 匹配：varName = "SQL..." 或 var varName = "SQL..."
    // 要求包含 " + 模式（字符串拼接）且不是多行块的首行
    if (!line.includes('" +') && !line.includes('+"')) return line;
    const m = line.match(/^(\s*)(var\s+)?(\w+(?:\.\w+)?)\s*(=)\s*"/);
    if (!m) return line;
    // 排除多行块的首行（以 + 结尾）
    if (line.trim().endsWith('+')) return line;

    const indent = m[1];
    const varKeyword = m[2] || '';
    const varName = m[3];
    const op = m[4];

    // 提取 = 后的内容
    let raw = line.substring(line.indexOf('=') + 1).trim();
    // 检测原始是否有 ; 结尾（保留一致性）
    const hasTrailingSemicolon = /;\s*$/.test(raw);
    // 移除末尾的 ;
    raw = raw.replace(/;\s*$/, '');

    // 处理 " + var + " 和 " + (expr) + " 模式
    let converted = raw;
    for (let j = 0; j < 10; j++) {
      const prev = converted;
      // 先匹配括号表达式如 (parent.gpm.cxtj.jcdm + 1)（支持嵌套括号），再匹配简单变量
      converted = converted.replace(/"\s*\+\s*(\((?:[^()]|\([^()]*\))*\))\s*\+\s*"/g, '${$1}');
      converted = converted.replace(/"\s*\+\s*([\w.()]+)\s*\+\s*"/g, '${$1}');
      if (converted === prev) break;
    }
    converted = converted.replace(/"\s*\+\s*(\((?:[^()]|\([^()]*\))*\))\s*$/g, '${$1}');
    converted = converted.replace(/"\s*\+\s*([\w.()]+)\s*$/g, '${$1}');
    converted = converted.replace(/^(\((?:[^()]|\([^()]*\))*\))\s*\+\s*"/g, '${$1}');
    converted = converted.replace(/^([\w.()]+)\s*\+\s*"/g, '${$1}');
    converted = converted.replace(/"\s*\+\s*"/g, '');
    converted = converted.replace(/^"/, '').replace(/"$/, '');

    count++;
    const suffix = hasTrailingSemicolon ? '`;' : '`';
    return `${indent}${varKeyword}${varName} ${op} \`${converted}${suffix}`;
  });
  return { content: result.join('\n'), count };
}

function findSqlBlocks(lines) {
  const blocks = [];
  const startRe = /(?:var\s+)?(\w+(?:\.\w+)?)\s*(\+=|=)\s*"/;
  // 首行无引号（如 str_sql +=），下一行以 " SELECT/FROM/WITH 开头
  const startReNoQuote = /(?:var\s+)?(\w+(?:\.\w+)?)\s*(\+=|=)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (isCommentLine(rawLine)) continue;
    // 剥离行尾 // 注释（注释会截断 + 拼接链）
    const line = rawLine.replace(/\s+\/\/.*$/, '');

    let m = line.match(startRe);
    let varName, op;
    if (m) {
      varName = m[1];
      op = m[2];
      // 首行有 " 但无 SQL 关键词 → 跳过
      if (!/SELECT|FROM|WITH/i.test(line)) continue;
    } else {
      // 首行无 "（如 str_sql +=），尝试无引号匹配
      m = line.match(startReNoQuote);
      if (!m) continue;
      varName = m[1];
      op = m[2];
      // 向前看一行，检查是否以 " + SQL 关键词开头
      let peekNext = i + 1;
      while (peekNext < lines.length && lines[peekNext].trim() === '') peekNext++;
      const nextRaw = peekNext < lines.length ? lines[peekNext].trim().replace(/\s+\/\/.*$/, '') : '';
      if (!nextRaw.startsWith('"') || !/SELECT|FROM|WITH/i.test(nextRaw)) continue;
    }

    const blockLines = [line];
    let inBlockComment = false;  // 跟踪 /* */ 跨行注释
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].trim().replace(/\s+\/\/.*$/, '');
      const prev = lines[j - 1].trim().replace(/\s+\/\/.*$/, '');
      // 向后跳过空行，找到真正的下一行（处理注释删除后留下多行空行的情况）
      let peekIdx = j + 1;
      while (peekIdx < lines.length && lines[peekIdx].trim().replace(/\s+\/\/.*$/, '') === '') peekIdx++;
      const nextNext = (peekIdx < lines.length) ? lines[peekIdx].trim().replace(/\s+\/\/.*$/, '') : '';

      // 跳过 /* */ 注释（单行或多行）
      if (inBlockComment) {
        blockLines.push(lines[j]);
        if (next.includes('*/')) inBlockComment = false;
        j++;
        continue;
      }
      if (next.startsWith('/*')) {
        blockLines.push(lines[j]);
        if (!next.includes('*/')) inBlockComment = true;
        j++;
        continue;
      }

      // 跳过 // 注释行（如 //+" BYRKJE_ZXW,"）
      if (next.startsWith('//')) {
        blockLines.push(lines[j]);
        j++;
        continue;
      }

      if (next.startsWith('+') || next === '+') {
        blockLines.push(lines[j]);
        j++;
      } else if ((next.startsWith('"') || next.startsWith("'") || next === '') &&
                 (nextNext.startsWith('+') || nextNext.startsWith('"'))) {
        blockLines.push(lines[j]);
        j++;
      } else if (next.startsWith('"') && (prev.endsWith('+') || prev.endsWith('"') || prev.endsWith('`'))) {
        // 前一行以 + 或 " 或 ` 结尾，当前行以 " 开头 → 续行
        blockLines.push(lines[j]);
        j++;
      } else if (/^\+?\s*\w+(\.\w+)*\s*\+?\s*;*\s*$/.test(next) && (prev.endsWith('+') || /`\s*;*\s*$/.test(prev))) {
        // 裸变量引用（如 fields 或 + fields），前一行以 + 结尾或以 `; 结尾（模板字面量闭合后续行）→ 续行
        blockLines.push(lines[j]);
        j++;
      } else if (/^\+?\s*\w+(\.\w+)*\s*\+/.test(next) && prev.endsWith('+')) {
        // 变量 + 字符串 模式（如 parent.gpm.cxtj.str_where_nd + ") A, ..."）
        // 前一行以 + 结尾 → 续行
        blockLines.push(lines[j]);
        j++;
      } else {
        break;
      }
    }

    if (blockLines.length > 1) {
      blocks.push({ startIdx: i, lines: blockLines, varName, op });
    }
  }

  // 按 startIdx 排序，确保处理顺序正确
  blocks.sort((a, b) => a.startIdx - b.startIdx);
  return blocks;
}

/**
 * 将多行 SQL 拼接块转换为模板字面量。
 * 逐行处理，保持多行结构。
 * 返回转换后的字符串数组，或 null（转换失败）。
 */
function convertBlockToTemplate(block) {
  try {
    const firstLine = block.lines[0];
    const m = firstLine.match(/^(\s*)(var\s+)?(\w+(?:\.\w+)?)\s*(\+?=)\s*/);
    if (!m) return null;
    const indent = m[1];
    const varKeyword = m[2] || '';
    const varName = m[3];
    const op = m[4];

    const result = [`${indent}${varKeyword}${varName} ${op} \``];

    // 检测原始 SQL 最后一行是否以 ; 结尾（保留一致性）
    const lastLine = block.lines[block.lines.length - 1].trim().replace(/\s+\/\/.*$/, '');
    const hasTrailingSemicolon = /;\s*$/.test(lastLine) || /["']\s*;\s*$/.test(lastLine);

    let inBlockComment = false;
    let pendingNewTemplate = false;  // backtick 闭合后，下一个 + " 需要新开模板字面量
    for (let i = 0; i < block.lines.length; i++) {
      let line = block.lines[i].trim();

      // 剥离行尾 // 注释（注释会截断 + 拼接链）
      line = line.replace(/\s+\/\/.*$/, '');

      // 跳过 /* */ 注释（单行或多行）
      if (inBlockComment) {
        if (line.includes('*/')) {
          inBlockComment = false;
          // */ 后可能有代码
          line = line.substring(line.indexOf('*/') + 2).trim();
          if (!line) continue;
        } else {
          continue;
        }
      }
      if (line.startsWith('/*')) {
        const endIdx = line.indexOf('*/', 2);
        if (endIdx >= 0) {
          // 单行注释，保留 */ 后的内容
          line = line.substring(endIdx + 2).trim();
          if (!line) continue;
        } else {
          inBlockComment = true;
          continue;
        }
      }

      // backtick 行（已有模板字面量的闭合）：闭合当前模板，标记后续需要新开
      if (line === '`' || line === '`;' || /^`[^`]*`$/.test(line)) {
        result.push(block.lines[i].trimEnd());
        pendingNewTemplate = true;
        continue;
      }

      // 跳过 // 注释行（如 //+" BYRKJE_ZXW,"）
      if (line.startsWith('//')) {
        continue;
      }

      // 第一行：移除 varName op " 前缀，保留 var 关键字
      if (i === 0) {
        line = line.replace(/^(\s*(?:var\s+)?)\w+(?:\.\w+)?\s*\+?=\s*"?/, '');
      } else {
        // 续行：移除开头的 + " 或变量 + "
        line = line.replace(/^\+\s*"?/, '');
        // 处理以变量或表达式开头的续行（如 parent.gpm.cxtj.str_where_nd + ") A, ..."）
        line = line.replace(/^(\w+(?:\.\w+)*)\s*\+\s*"/, '${$1}');
        // 处理裸变量行（如 + parent.gpm.cxtj.date）
        line = line.replace(/^\+\s*(\w+(?:\.\w+)*)\s*$/, '${$1}');

        // backtick 闭合后，续行需要新开模板字面量
        if (pendingNewTemplate && line) {
          const lineIndent = block.lines[i].match(/^(\s*)/)[1] || '          ';
          result.push(lineIndent + '`');
          pendingNewTemplate = false;
        }
      }

      // 移除行尾的 " + （续行标记）、末尾引号、分号
      line = line.replace(/"\s*\+\s*$/, '');
      line = line.replace(/"?\s*;?\s*$/, '');

      // 处理行内的 " + var + " 和 " + (expr) + " 模式
      // 多次替换直到稳定
      for (let j = 0; j < 10; j++) {
        const prev = line;
        // 先匹配括号表达式如 (parent.gpm.cxtj.jcdm + 1)（支持嵌套括号），再匹配简单变量
        line = line.replace(/"\s*\+\s*(\((?:[^()]|\([^()]*\))*\))\s*\+\s*"/g, '${$1}');
        line = line.replace(/"\s*\+\s*([\w.()]+)\s*\+\s*"/g, '${$1}');
        if (line === prev) break;
      }
      // 行尾的 " + (expr) +（没有后续开引号，下一行以 " 开头）
      line = line.replace(/"\s*\+\s*(\((?:[^()]|\([^()]*\))*\))\s*\+\s*$/g, '${$1}');
      // 行尾的 " + var +（没有后续开引号，下一行以 " 开头）
      line = line.replace(/"\s*\+\s*([\w.()]+)\s*\+\s*$/g, '${$1}');
      // 行尾的 " + (expr)（没有后续开引号）
      line = line.replace(/"\s*\+\s*(\((?:[^()]|\([^()]*\))*\))\s*$/g, '${$1}');
      // 行尾的 " + var（没有后续开引号）
      line = line.replace(/"\s*\+\s*([\w.()]+)\s*$/g, '${$1}');
      // 行首的 (expr) + " 或 var + "（没有前导闭引号）
      line = line.replace(/^(\((?:[^()]|\([^()]*\))*\))\s*\+\s*"/g, '${$1}');
      line = line.replace(/^([\w.()]+)\s*\+\s*"/g, '${$1}');
      // " + "（字符串段拼接，无变量）→ 移除
      line = line.replace(/"\s*\+\s*"/g, '');

      // 移除剩余的边界引号
      line = line.replace(/^"/, '').replace(/"$/, '');

      // 清理多余空格
      line = line.replace(/\s{2,}/g, ' ').trim();

      // 纯变量行（如 fields、str_where）→ ${var}
      // 排除 SQL 关键字，避免将 SELECT/FROM/WHERE 等误转为 ${SELECT}
      const SQL_KEYWORDS = new Set([
        'SELECT','FROM','WHERE','AND','OR','ON','AS','SET','IN','NOT','NULL',
        'CASE','WHEN','THEN','ELSE','END','JOIN','LEFT','RIGHT','INNER','OUTER','CROSS',
        'UNION','ALL','DISTINCT','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET',
        'INSERT','INTO','VALUES','UPDATE','DELETE','CREATE','DROP','ALTER','TABLE',
        'BETWEEN','LIKE','EXISTS','ANY','SOME','CAST','OVER','PARTITION','ROWS',
        'RANGE','UNBOUNDED','PRECEDING','FOLLOWING','CURRENT','ASC','DESC','NEXT',
        'FETCH','FIRST','LAST','ONLY','WITH','RECURSIVE','EXCEPT','INTERSECT','MINUS',
        'ROW_NUMBER','ROWNUM','DUAL','IS','TRUE','FALSE','TOP','IF','REPLACE',
        'ROUND','IFNULL','SUM','COUNT','MAX','MIN','AVG','COALESCE','CONVERT',
        'DATE_FORMAT','SUBSTRING','CHAR_LENGTH','NOW','TRIM','UPPER','LOWER',
        'CONCAT','CONCAT_WS','GROUP_CONCAT','ABS','CEIL','FLOOR','MOD','POWER',
        'STR_TO_DATE','YEAR','MONTH','DAY','HOUR','MINUTE','SECOND'
      ]);
      line = line.replace(/^([\w.()]+)\s*\+?\s*;*\s*$/, (match, varName) => {
        // 排除单个字符（如括号）、SQL 关键字
        if (varName.length <= 1) return match;
        if (SQL_KEYWORDS.has(varName.toUpperCase())) return match;
        // 排除表别名引用（如 T.RKJE、S.SWJG_MC）- 包含大写字母开头的别名
        if (/^[A-Z]\./.test(varName)) return match;
        return '${' + varName + '}';
      });

      if (line) {
        // 保持原始缩进（使用续行的缩进）
        const lineIndent = i > 0 ? (block.lines[i].match(/^(\s*)/)[1] || '          ') : '';
        result.push(lineIndent + line);
      }
    }

    result.push(hasTrailingSemicolon ? `${indent}\`;` : `${indent}\``);
    return result.join('\n');
  } catch (e) {
    return null;
  }
}

// ==================== PIVOT 转换 ====================

/**
 * 将 Oracle PIVOT 语法转换为 MySQL SUM(CASE WHEN ... END)
 * 仅处理模板字面量内部的 PIVOT（已被反引号包裹）
 *
 * Oracle:
 *   PIVOT(SUM(HS_HJ) HS, SUM(JMSE_HJ) JMSE FOR SWJG_DM IN ('v1' C1, 'v2' C2))
 * MySQL:
 *   SUM(CASE WHEN SWJG_DM='v1' THEN HS_HJ ELSE 0 END) AS C1_HS,
 *   SUM(CASE WHEN SWJG_DM='v1' THEN JMSE_HJ ELSE 0 END) AS C1_JMSE, ...
 *   GROUP BY <non-pivot columns>
 */
function convertPivot(content) {
  let count = 0;
  const lines = content.split('\n');
  let inTemplate = false;
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const backtickCount = (line.match(/`/g) || []).length;

    if (!inTemplate) {
      if (backtickCount % 2 === 1) inTemplate = true;
      result.push(line);
      continue;
    }

    if (backtickCount % 2 === 1) {
      inTemplate = false;
      result.push(line);
      continue;
    }

    // 在模板字面量内部，查找 PIVOT(（可能在行中间）
    const pivotIdx = line.indexOf('PIVOT(');
    if (pivotIdx === -1) {
      result.push(line);
      continue;
    }

    const beforePivot = line.substring(0, pivotIdx);
    const indent = beforePivot.match(/^(\s*)/)[1];

    // 收集 PIVOT 内容（可能跨多行），从 PIVOT( 后开始
    let pivotContent = line.substring(pivotIdx + 6);
    let pivotEndLine = i;
    let depth = 1; // PIVOT( 的开括号
    let closed = false;
    for (let j = i; j < lines.length && !closed; j++) {
      const lineToCheck = j === i ? pivotContent : lines[j];
      for (let ci = 0; ci < lineToCheck.length; ci++) {
        if (lineToCheck[ci] === '(') depth++;
        else if (lineToCheck[ci] === ')') {
          depth--;
          if (depth === 0) {
            // 截断到此字符（不含闭合括号）
            if (j === i) {
              pivotContent = pivotContent.substring(0, ci);
            } else {
              pivotContent += '\n' + lines[j].substring(0, ci);
            }
            pivotEndLine = j;
            closed = true;
            break;
          }
        }
      }
      if (!closed && j > i) {
        pivotContent += '\n' + lines[j];
      }
      if (!closed) pivotEndLine = j;
    }
    if (!closed) {
      result.push(line);
      continue;
    }

    // 解析：agg(col) alias, agg(col) alias ... FOR pivotCol IN (values)
    // 找到 FOR 关键字的位置（不在括号内的 FOR）
    let forIdx = -1;
    {
      let pDepth = 0;
      const upper = pivotContent.toUpperCase();
      for (let k = 0; k < pivotContent.length - 3; k++) {
        if (pivotContent[k] === '(') pDepth++;
        else if (pivotContent[k] === ')') pDepth--;
        if (pDepth === 0 && /\s/.test(pivotContent[k]) && upper.substring(k + 1, k + 4) === 'FOR') {
          forIdx = k + 1;
          break;
        }
      }
    }
    if (forIdx === -1) {
      result.push(line);
      continue;
    }

    const aggPart = pivotContent.substring(0, forIdx).trim();
    const afterFor = pivotContent.substring(forIdx + 3).trim();

    // 解析 pivotCol IN (values)
    // IN 可能在字面值中，也可能在模板变量中（如 ${swjg_tj} 包含 IN (...)）
    let pivotCol, valuesPart;
    const inMatch = afterFor.match(/^(\w+)\s+IN\s*\((.+)\)$/s);
    if (inMatch) {
      pivotCol = inMatch[1].trim();
      valuesPart = inMatch[2].trim();
    } else {
      // 尝试匹配：pivotCol ${var}（IN 在模板变量中）
      const varMatch = afterFor.match(/^(\w+)\s+(\$\{.+\})\s*$/s);
      if (varMatch) {
        pivotCol = varMatch[1].trim();
        valuesPart = varMatch[2].trim();
      } else {
        result.push(line);
        continue;
      }
    }

    // 检查是否包含模板变量（如 ${swjg_tj}）
    const hasTemplateVar = /\$\{/.test(valuesPart);

    // 解析聚合对：SUM(HS_HJ) HS, MAX(JMSE_TB_HJ) JMSE_TB
    const aggPairs = [];
    const aggRegex = /(\w+)\((\w+)\)\s+(\w+)/g;
    let m;
    while ((m = aggRegex.exec(aggPart)) !== null) {
      aggPairs.push({ func: m[1], col: m[2], alias: m[3] });
    }

    if (aggPairs.length === 0) {
      result.push(line);
      continue;
    }

    if (hasTemplateVar) {
      // 包含模板变量（如 ${swjg_tj}）：
      // 将 PIVOT(...) 替换为 ${pivotCols}
      // pivotCols 需要在 JS 代码中由 LLM 生成
      result.push(beforePivot + '${pivotCols}');
      i = pivotEndLine;
      count++;
      continue;
    }

    // 解析 IN 值：'value1' C1, 'value2' C2
    const pivotValues = [];
    const valRegex = /'([^']+)'\s+(\w+)/g;
    while ((m = valRegex.exec(valuesPart)) !== null) {
      pivotValues.push({ value: m[1], alias: m[2] });
    }

    if (pivotValues.length === 0) {
      result.push(line);
      continue;
    }

    // 生成 MySQL CASE WHEN 表达式
    const caseExprs = [];
    for (const pv of pivotValues) {
      for (const ap of aggPairs) {
        const caseExpr = `${ap.func}(CASE WHEN ${pivotCol}='${pv.value}' THEN ${ap.col} ELSE 0 END) AS ${pv.alias}_${ap.alias}`;
        caseExprs.push(caseExpr);
      }
    }

    // 替换：输出 PIVOT 前的内容 + CASE WHEN 表达式
    const lastIdx = caseExprs.length - 1;
    for (let k = 0; k <= lastIdx; k++) {
      const comma = k < lastIdx ? ',' : '';
      if (k === 0) {
        result.push(`${beforePivot}${caseExprs[k]}${comma}`);
      } else {
        result.push(`${indent}${caseExprs[k]}${comma}`);
      }
    }

    // 跳过被替换的行
    i = pivotEndLine;
    count++;
  }

  return { content: result.join('\n'), count };
}

// ==================== 跨行 to_char 合并 ====================

/**
 * 合并跨行的 to_char(round(...)) 模式
 * 场景：字符串拼接块中 to_char 被拆分到两行
 *   行1: "...to_char(round((expr)/" + je_dw +
 *   行2: ",2))||'</span>'..."  或  ",2))||'</span>'..."
 * 合并后统一由后续的 convertToChar* 函数处理
 *
 * 也处理注释删除后的残留 + 和空行
 */
function mergeSplitToChar(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // 清理行尾 JS 拼接符号用于检测
    const lineClean = line.replace(/\s*\+\s*$/, '');

    // 检查当前行是否有 to_char( 且没有对应的闭合括号
    const toCharIdx = lineClean.toUpperCase().indexOf('TO_CHAR(');
    if (toCharIdx !== -1) {
      // 检查当前行 to_char 后是否有完整的闭合括号
      let depth = 0;
      let hasComplete = false;
      for (let k = toCharIdx + 7; k < lineClean.length; k++) {
        if (lineClean[k] === '(') depth++;
        else if (lineClean[k] === ')') {
          depth--;
          if (depth === 0) { hasComplete = true; break; }
        }
      }

      if (!hasComplete) {
        // to_char 未闭合，向前查找包含 ,2)) 的行（跳过空行和单独的 + 行）
        let j = i + 1;
        let mergeTarget = -1;
        while (j < lines.length && j <= i + 3) {
          const lookLine = lines[j].trim();
          if (lookLine === '' || lookLine === '+' || lookLine === ';') {
            j++;
            continue;
          }
          // 检查是否包含 ,2))（可能以 ",2)) 或 ,2)) 开头）
          if (lookLine.includes(',2))')) {
            mergeTarget = j;
            break;
          }
          break; // 遇到其他行就停止
        }

        if (mergeTarget !== -1) {
          // 合并：移除当前行末尾的 +，拼接目标行
          const merged = line.replace(/\s*\+\s*$/, '') + lines[mergeTarget].trim();
          result.push(merged);
          count++;
          i = mergeTarget; // 跳过中间的所有行
          continue;
        }
      }
    }

    result.push(line);
  }

  return { content: result.join('\n'), count };
}

// ==================== 修复模板字面量残留的 " + var" ====================

/**
 * 修复模板字面量重构后残留的 " + var" 模式
 * 场景：跨行 to_char 合并后，refactorTemplateLiterals 的 regex 未能匹配所有 " + var + " 模式
 * 残留：/" + je_dw"  →  /${je_dw}
 */
function fixResidualStringConcat(content) {
  let count = 0;
  // 匹配：/" + var" 或 )" + var"  → /${var} 或 )${var}
  // 不匹配引号内部的 " + var"（通过检查前面是否有非 / 或 ) 的字符）
  const result = content.replace(/(\/|,)\s*"\s*\+\s*(\w+(?:\.\w+)*)\s*"\s*/g, (match, prefix, varName) => {
    count++;
    return prefix + '${' + varName + '}';
  });
  return { content: result, count };
}

// ==================== 修复 top.html 中 swjg SQL 拼接问题 ====================

/**
 * 修复 top.html 中税务机关 SQL 拼接被错误拆分的问题
 *
 * 原始字符串拼接代码中的两个问题：
 * 问题1: _urlParams.swjg_dm 跨行断开（属性访问在下一行）
 *   原: + _urlParams\r\n            .swjg_dm +
 *   新: + _urlParams.swjg_dm +
 *
 * 问题2: decode 中 _urlParams.swjg_dm 的 + 号把 SQL 断成两截
 *   原: decode(swjg_dm,'" + _urlParams.swjg_dm +\r\n            "','true','false')
 *   新: decode(swjg_dm,'" + _urlParams.swjg_dm + "','true','false')
 *
 * 必须在模板字面量转换之前执行（pre-template-literal pass）
 */
function fixTopHtmlSwjgSql(content) {
  let count = 0;
  let result = content;

  // 修复模式1: _urlParams.swjg_dm 属性访问跨行
  // 原: + _urlParams\r\n            .swjg_dm +
  // 新: + _urlParams.swjg_dm +
  const pattern1 = /\+ _urlParams\r?\n\s*\.swjg_dm \+/g;
  const matches1 = result.match(pattern1);
  if (matches1) {
    result = result.replace(pattern1, '+ _urlParams.swjg_dm +');
    count += matches1.length;
  }

  // 修复模式2: decode 中 _urlParams.swjg_dm 后的 + 号换行
  // 原: _urlParams.swjg_dm +\r\n            "','true','false')
  // 新: _urlParams.swjg_dm + "','true','false')
  const pattern2 = /_urlParams\.swjg_dm \+\r?\n\s*"','true','false'\)/g;
  const matches2 = result.match(pattern2);
  if (matches2) {
    result = result.replace(pattern2, `_urlParams.swjg_dm + "','true','false')`);
    count += matches2.length;
  }

  return { content: result, count };
}

// ==================== 清理模板字面量内的 // 注释 ====================

/**
 * 清理模板字面量（反引号）内部的 // 注释
 * 场景：原始代码中 // 在引号字符串内部（被 removeInlineComments 正确保留），
 *       但模板字面量转换后 // 变成了真正的 JS 注释，会截断后续代码
 *
 * 原始: + " ... ) T1, "  //  这是注释
 * 转换后: `... ) T1, `  //  这是注释  ← // 现在是真正的 JS 注释！
 * 期望: `... ) T1, `
 */
function removeTemplateLiteralComments(content) {
  let count = 0;
  const lines = content.split('\n');
  let inTemplate = false;
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const backtickCount = (line.match(/`/g) || []).length;

    // 跟踪模板字面量状态
    if (!inTemplate) {
      if (backtickCount % 2 === 1) inTemplate = true;
      result.push(line);
      continue;
    }

    if (backtickCount % 2 === 1) {
      // 模板字面量在这行结束
      inTemplate = false;
      // 检查闭合反引号后是否有 // 注释
      const lastBacktick = line.lastIndexOf('`');
      const afterBacktick = line.substring(lastBacktick + 1);
      if (afterBacktick.includes('//')) {
        const commentIdx = afterBacktick.indexOf('//');
        const beforeComment = afterBacktick.substring(0, commentIdx);
        // 闭合反引号后有 // 注释，删除注释部分，保留其他代码
        const cleaned = line.substring(0, lastBacktick + 1) + beforeComment.trimEnd();
        result.push(cleaned);
        count++;
        continue;
      }
      result.push(line);
      continue;
    }

    // 在模板字面量内部，检查行尾 // 注释
    if (line.includes('//')) {
      const commentIdx = line.indexOf('//');
      const beforeComment = line.substring(0, commentIdx);
      // 检查 // 是否在 ${} 表达式内部（不应删除）
      const openBraces = (beforeComment.match(/\$\{/g) || []).length;
      const closeBraces = (beforeComment.match(/\}/g) || []).length;
      if (openBraces > closeBraces) {
        // // 在 ${} 内部，保留
        result.push(line);
        continue;
      }
      // 检查 // 前面是否有奇数个 ' 或 "（在残留的引号字符串内部）
      const singleQuotes = (beforeComment.match(/'/g) || []).length;
      const doubleQuotes = (beforeComment.match(/"/g) || []).length;
      if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
        // // 在引号内部，保留
        result.push(line);
        continue;
      }
      // // 是注释，剥离
      const trimmed = beforeComment.trimEnd();
      if (trimmed) {
        result.push(trimmed);
        count++;
      } else {
        // 整行都是注释，删除
        count++;
      }
      continue;
    }

    result.push(line);
  }

  return { content: result.join('\n'), count };
}

// ==================== 字符串拼接块中 || → CONCAT ====================

/**
 * 转换 SQL 字符串中的 || 拼接为 CONCAT()
 * 处理场景：
 *   1. 'string'||expr  →  CONCAT('string', expr)
 *   2. expr||'string'  →  CONCAT(expr, 'string')
 *   3. 'str1'||expr||'str2'  →  CONCAT('str1', expr, 'str2')
 *
 * 仅处理 SQL 内容中的 ||（在引号字符串内部），不处理 JS 拼接的 +
 */
function convertStringConcat(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line) || !line.includes('||')) return line;

    let modified = line;

    // 模式1: 'string'||CONCAT/CAST/expr → CONCAT('string', CONCAT/CAST/expr)
    // 匹配：引号字符串紧跟 ||
    modified = modified.replace(/'([^']*)'\|\|(CONCAT|CAST|[A-Za-z_]\w*\()/g, (match, str, func) => {
      count++;
      return `CONCAT('${str}', ${func}`;
    });

    // 模式2: AS CHAR)||'string'  →  AS CHAR), 'string')
    // 匹配：闭合括号后跟 || 和引号字符串
    modified = modified.replace(/\)\|\|'([^']*)'/g, (match, str) => {
      count++;
      return `), '${str}')`;
    });

    // 模式3: expr||'string'（变量或函数调用后跟 || 和字符串）
    // 匹配：标识符后跟 || 和引号字符串（但不是已经处理过的 CONCA/CAST 模式）
    modified = modified.replace(/([A-Za-z_]\w*(?:\.\w+)*)\|\|'([^']*)'/g, (match, expr, str) => {
      // 排除已经被模式1处理的（前面有 CONCAT( 的）
      count++;
      return `CONCAT(${expr}, '${str}')`;
    });

    return modified;
  });

  return { content: result.join('\n'), count };
}

// ==================== DECODE → CASE WHEN ====================

/**
 * 查找与开括号位置匹配的闭合括号位置（支持深度嵌套）
 * @param {string} str - 要搜索的字符串
 * @param {number} openPos - 开括号位置
 * @returns {number} - 闭合括号位置，-1 表示未找到
 */
function findClosingParenForDecode(str, openPos) {
  let depth = 0;
  for (let k = openPos; k < str.length; k++) {
    if (str[k] === '(') depth++;
    else if (str[k] === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * 将单个 DECODE 调用转换为 CASE WHEN
 * @param {string} inner - DECODE 括号内的内容
 * @returns {string|null} - CASE WHEN 表达式，失败返回 null
 */
function convertSingleDecode(inner) {
  // 解析参数：按逗号分割，但要处理嵌套括号
  const args = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') {
      depth++;
      current += inner[i];
    } else if (inner[i] === ')') {
      depth--;
      current += inner[i];
    } else if (inner[i] === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += inner[i];
    }
  }
  if (current.trim()) args.push(current.trim());

  // DECODE 至少需要 3 个参数：expr, search, result [, search, result, ...] [, default]
  if (args.length < 3) return null;

  const expr = args[0];
  const pairs = [];

  // 每两个参数一对 (search, result)，最后一个是 default（如果有奇数个剩余参数）
  let i = 1;
  while (i + 1 < args.length) {
    pairs.push({ search: args[i], result: args[i + 1] });
    i += 2;
  }
  const defaultVal = i < args.length ? args[i] : null;

  // 生成 CASE WHEN
  const caseParts = [];
  for (const pair of pairs) {
    if (pair.search.toUpperCase() === 'NULL') {
      caseParts.push(`WHEN ${expr} IS NULL THEN ${pair.result}`);
    } else {
      caseParts.push(`WHEN ${expr}=${pair.search} THEN ${pair.result}`);
    }
  }
  if (defaultVal !== null) {
    caseParts.push(`ELSE ${defaultVal}`);
  }
  return `CASE ${caseParts.join(' ')} END`;
}

/**
 * 处理字符串中的 DECODE 转换（用于模板字面量内部和普通行）
 * 使用字符串扫描而非正则，支持任意深度嵌套
 * @param {string} text - 要处理的文本
 * @returns {{text: string, count: number}} - 处理后的文本和转换次数
 */
function processDecodeInText(text) {
  let count = 0;
  let result = text;

  // 循环处理多个 DECODE（从内到外处理嵌套）
  for (let iter = 0; iter < 100; iter++) {
    // 查找最后一个 DECODE(（从后往前找，这样能先处理内层）
    const upperResult = result.toUpperCase();
    let lastDecodeIdx = -1;
    let searchFrom = 0;
    while (true) {
      const idx = upperResult.indexOf('DECODE(', searchFrom);
      if (idx === -1) break;
      lastDecodeIdx = idx;
      searchFrom = idx + 7;
    }

    if (lastDecodeIdx === -1) break;

    // 找到匹配的闭合括号
    const openParenIdx = lastDecodeIdx + 6; // DECODE 后的 ( 位置
    const closeParenIdx = findClosingParenForDecode(result, openParenIdx);
    if (closeParenIdx === -1) break;

    // 提取 DECODE 内容
    const inner = result.substring(openParenIdx + 1, closeParenIdx);
    const fullMatch = result.substring(lastDecodeIdx, closeParenIdx + 1);

    // 转换
    const caseExpr = convertSingleDecode(inner);
    if (caseExpr) {
      result = result.substring(0, lastDecodeIdx) + caseExpr + result.substring(closeParenIdx + 1);
      count++;
    } else {
      break; // 无法转换，退出
    }
  }

  return { text: result, count };
}

/**
 * 将 Oracle DECODE 转换为 MySQL CASE WHEN
 * 支持嵌套 DECODE、NULL 比较、模板字面量内部
 */
function convertDecode(content) {
  let totalCount = 0;
  const lines = content.split('\n');
  let inTemplate = false;
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const backtickCount = (line.match(/`/g) || []).length;

    // 跟踪模板字面量状态
    if (!inTemplate) {
      if (backtickCount % 2 === 1) {
        inTemplate = true;
      }
    } else {
      if (backtickCount % 2 === 1) {
        inTemplate = false;
      }
    }

    // 所有行都检查是否有 DECODE（包括模板字面量内部）
    if (/DECODE\(/i.test(line)) {
      const { text, count } = processDecodeInText(line);
      if (count > 0) {
        line = text;
        totalCount += count;
      }
    }

    result.push(line);
  }

  return { content: result.join('\n'), count: totalCount };
}

// ==================== FM99 格式转换 ====================

/**
 * 将 Oracle 的 TO_CHAR(number, 'FM999,999,999,999,999,999,990.00') 转换为 MySQL 的 FORMAT(number, 2)
 * 支持各种 FM99 格式变体
 */
function convertFm99Format(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (isCommentLine(line)) return line;

    let modified = line;
    // 匹配 TO_CHAR(expr, 'FM999,999,999,999,999,999,990.00') 或类似格式
    // 支持各种数字位数和小数位数
    // 使用 .+? 匹配表达式（支持嵌套括号和逗号）
    const fm99Re = /TO_CHAR\s*\(\s*(.+?)\s*,\s*'FM[9,]+0\.([0-9]+)'\s*\)/gi;
    let match;
    while ((match = fm99Re.exec(line)) !== null) {
      const expr = match[1].trim();
      const decimalStr = match[2];
      // 计算小数位数（如 '00' -> 2, '000' -> 3）
      const decimalPlaces = decimalStr.length;
      const replacement = `FORMAT(${expr}, ${decimalPlaces})`;
      modified = modified.replace(match[0], replacement);
      count++;
    }

    return modified;
  });

  return { content: result.join('\n'), count };
}

// ==================== 复杂模式扫描 ====================

function scanComplexPatterns(content, complexKeywords) {
  const found = [];
  const lines = content.split('\n');
  // ROWNUM 误报过滤：驼峰 rowNum 是 JS 变量，不是 Oracle ROWNUM
  const rownumJsRe = /\browNum\b/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    for (const kw of complexKeywords) {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      if (re.test(line)) {
        // 过滤 ROWNUM 误报：JS 变量名 rowNum（驼峰）不是 Oracle ROWNUM
        if (kw === 'rownum' && rownumJsRe.test(line)) continue;
        const c = countMatches(line, re);
        for (let j = 0; j < c; j++) {
          found.push({ keyword: kw, line: i + 1, content: line.trim().substring(0, 120) });
        }
      }
    }
  }
  return found;
}

// ==================== 删除引号字符串内部的 // 注释 ====================

/**
 * 删除引号字符串内部的 // 注释残留
 * 场景：+ " ... ) T1, "  //  这是注释
 * // 在引号内部（前面有奇数个引号），模板转换后会暴露为真正的 JS 注释
 *
 * 匹配模式：闭合引号(" 或 ') + 空白 + // + 注释内容
 * 仅当 // 前面的引号数量为奇数时（说明 // 在字符串内部）
 */
function removeCommentsInsideStrings(content) {
  let count = 0;
  const lines = content.split('\n');
  const result = lines.map(line => {
    if (!line.includes('//')) return line;

    // 查找所有 // 位置
    const allIdx = [];
    let searchFrom = 0;
    while (true) {
      const idx = line.indexOf('//', searchFrom);
      if (idx === -1) break;
      allIdx.push(idx);
      searchFrom = idx + 2;
    }

    // 从后往前找在引号内部的 //
    for (let k = allIdx.length - 1; k >= 0; k--) {
      const commentIdx = allIdx[k];
      // 检查 // 前面是否有 : (URL) 或是 ///
      if (commentIdx > 0 && line[commentIdx - 1] === ':') continue;
      if (commentIdx + 2 < line.length && line[commentIdx + 2] === '/') continue;

      const beforeComment = line.substring(0, commentIdx);
      const singleQuotes = (beforeComment.match(/'/g) || []).length;
      const doubleQuotes = (beforeComment.match(/"/g) || []).length;

      // 奇数引号 → // 在字符串内部，是注释残留
      if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
        // 检查 // 前面是否有闭合引号 + 空白模式（如 "  // 或 '  //）
        const beforeTrimmed = beforeComment.trimEnd();
        if (beforeTrimmed.endsWith('"') || beforeTrimmed.endsWith("'")) {
          // 删除 // 及其后面的内容，保留闭合引号
          count++;
          return beforeComment.trimEnd();
        }
      }
    }

    return line;
  });

  return { content: result.join('\n'), count };
}

// ==================== 识别 SQL 块行 ====================

/**
 * 获取 SQL 块所在的行号集合
 * 包括：模板字面量内的行、字符串拼接块的行
 */
function getSqlBlockLines(content) {
  const lines = content.split('\n');
  const sqlBlockLines = new Set();

  // 1. 标记模板字面量内的行
  let inTemplate = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const backtickCount = (line.match(/`/g) || []).length;
    if (!inTemplate) {
      if (backtickCount % 2 === 1) {
        inTemplate = true;
        sqlBlockLines.add(i);
      }
    } else {
      sqlBlockLines.add(i);
      if (backtickCount % 2 === 1) {
        inTemplate = false;
      }
    }
  }

  // 2. 标记字符串拼接块的行（varName = "SQL..." 或 varName += "SQL..."）
  const startRe = /(?:var\s+)?(\w+(?:\.\w+)?)\s*(\+=|=)\s*"/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+\/\/.*$/, '');
    const m = line.match(startRe);
    if (!m) continue;
    if (!/SELECT|FROM/i.test(line)) continue;

    // 标记起始行
    sqlBlockLines.add(i);
    // 标记续行
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].trim().replace(/\s+\/\/.*$/, '');
      const prev = lines[j - 1].trim().replace(/\s+\/\/.*$/, '');
      const nextNext = (j + 1 < lines.length) ? lines[j + 1].trim().replace(/\s+\/\/.*$/, '') : '';
      if (next.startsWith('+') || next === '+') {
        sqlBlockLines.add(j);
        j++;
      } else if ((next.startsWith('"') || next.startsWith("'") || next === '') &&
                 (nextNext.startsWith('+') || nextNext.startsWith('"'))) {
        sqlBlockLines.add(j);
        j++;
      } else if (next.startsWith('"') && (prev.endsWith('+') || prev.endsWith('"'))) {
        sqlBlockLines.add(j);
        j++;
      } else {
        break;
      }
    }
  }

  return sqlBlockLines;
}

// ==================== 主程序 ====================

function main() {
  const args = parseArgs();
  const config = loadConfig(args.config);
  const targetPath = path.resolve(args.target);

  console.log('=== Oracle-to-MySQL 预处理工具 ===');
  console.log(`目标路径: ${targetPath}\n`);

  const keywords = loadKeywords(config.keywordsConfigPath);
  const files = scanFiles(targetPath);
  console.log(`扫描到 ${files.length} 个 HTML 文件`);

  const report = { targetPath, processedFiles: [] };

  for (const filePath of files) {
    console.log(`\n处理: ${path.relative(targetPath, filePath)}`);
    let content = fs.readFileSync(filePath, 'utf-8');

    // 检测原始换行符格式（CRLF 或 LF）
    const hasCRLF = content.includes('\r\n');
    // 统一转换为 LF 进行处理
    if (hasCRLF) {
      content = content.replace(/\r\n/g, '\n');
    }

    const fileReport = {
      file: path.relative(targetPath, filePath).replace(/\\/g, '/'),
      simpleReplacements: 0,
      patternReplacements: 0,
      toCharConversions: 0,
      toCharNumberConversions: 0,
      concatConversions: 0,
      concatPipeFixes: 0,
      commentRemovals: 0,
      mergeSplitToChar: 0,
      toDateConversions: 0,
      instrConversions: 0,
      toNumberConversions: 0,
      addMonthsConversions: 0,
      monthsBetweenConversions: 0,
      decodeConversions: 0,
      pivotConversions: 0,
      fm99Conversions: 0,
      swjgSqlFixes: 0,
      templateLiteralConverted: 0,
      templateLiteralFailed: [],
      complexPatterns: []
    };

    // 0. 识别非 SQL 行（这些行的注释应该保留）
    const sqlBlockLines = getSqlBlockLines(content);
    const allLines = new Set(Array.from({ length: content.split('\n').length }, (_, i) => i));
    const preserveLines = new Set([...allLines].filter(i => !sqlBlockLines.has(i)));
    console.log(`  SQL块行数: ${sqlBlockLines.size}, 保留注释行数: ${preserveLines.size}`);

    // 0a. 删除模板字面量中的注释行
    const r0 = removeSqlBlockComments(content);
    content = r0.content;
    fileReport.commentRemovals = r0.count;
    if (r0.count > 0) console.log(`  删除注释(模板): ${r0.count} 处`);

    // 0b. 删除 SQL 块行中的 // 注释（非 SQL 行的注释保留不动）
    const r0b = removeInlineComments(content, preserveLines);
    content = r0b.content;
    fileReport.commentRemovals += r0b.count;
    if (r0b.count > 0) console.log(`  删除注释(行内): ${r0b.count} 处`);

    // 0c. 删除引号字符串内部的 // 注释残留
    //     场景：+ " ... ) T1, "  //  注释
    //     // 在引号内部（奇数引号），模板转换后会暴露为真正的 JS 注释
    const r0c = removeCommentsInsideStrings(content);
    content = r0c.content;
    fileReport.commentRemovals += r0c.count;
    if (r0c.count > 0) console.log(`  删除注释(引号内): ${r0c.count} 处`);

    // 1. 简单替换
    const r1 = simpleReplace(content, config);
    content = r1.content;
    fileReport.simpleReplacements = r1.count;
    if (r1.count > 0) console.log(`  简单替换: ${r1.count} 处`);

    // 2. 模式替换（rownum、TO_CHAR→CAST 等固定模式）
    const r1b = patternReplace(content, config);
    content = r1b.content;
    fileReport.patternReplacements = r1b.count;
    if (r1b.count > 0) console.log(`  模式替换: ${r1b.count} 处`);

    // 2b. TO_CHAR(date, 'format') → DATE_FORMAT
    const r1c = config.toCharConversions !== false ? convertToChar(content) : { content, count: 0 };
    content = r1c.content;
    fileReport.toCharConversions = r1c.count;
    if (r1c.count > 0) console.log(`  TO_CHAR→DATE_FORMAT: ${r1c.count} 处`);

    // 2b2. 合并跨行的 to_char(round(...))（字符串拼接块中被 + 拆分的）
    const r1c2 = mergeSplitToChar(content);
    content = r1c2.content;
    if (r1c2.count > 0) console.log(`  合并跨行to_char: ${r1c2.count} 处`);

    // 2c. TO_CHAR(number) → CAST(number AS CHAR)
    const r1d = convertToCharForNumber(content);
    content = r1d.content;
    fileReport.toCharNumberConversions = r1d.count;
    fileReport.mergeSplitToChar = r1c2.count;
    if (r1d.count > 0) console.log(`  TO_CHAR→CAST AS CHAR: ${r1d.count} 处`);

    // 2d. TO_DATE → STR_TO_DATE
    const r1e = convertToDate(content);
    content = r1e.content;
    fileReport.toDateConversions = r1e.count;
    if (r1e.count > 0) console.log(`  TO_DATE→STR_TO_DATE: ${r1e.count} 处`);

    // 2e. INSTR → LOCATE
    const r1f = convertInstr(content);
    content = r1f.content;
    fileReport.instrConversions = r1f.count;
    if (r1f.count > 0) console.log(`  INSTR→LOCATE: ${r1f.count} 处`);

    // 2f. TO_NUMBER → CAST(AS DECIMAL)
    const r1g = convertToNumber(content);
    content = r1g.content;
    fileReport.toNumberConversions = r1g.count;
    if (r1g.count > 0) console.log(`  TO_NUMBER→CAST DECIMAL: ${r1g.count} 处`);

    // 2g. ADD_MONTHS → DATE_ADD/DATE_SUB
    const r1h = convertAddMonths(content);
    content = r1h.content;
    fileReport.addMonthsConversions = r1h.count;
    if (r1h.count > 0) console.log(`  ADD_MONTHS→DATE_ADD: ${r1h.count} 处`);

    // 2h. MONTHS_BETWEEN → TIMESTAMPDIFF
    const r1i = convertMonthsBetween(content);
    content = r1i.content;
    fileReport.monthsBetweenConversions = r1i.count;
    if (r1i.count > 0) console.log(`  MONTHS_BETWEEN→TIMESTAMPDIFF: ${r1i.count} 处`);

    // 2j. 修复 top.html 中 swjg SQL 拼接问题（必须在模板字面量转换之前）
    const r1j = fixTopHtmlSwjgSql(content);
    content = r1j.content;
    fileReport.swjgSqlFixes = r1j.count;
    if (r1j.count > 0) console.log(`  修复swjg SQL拼接: ${r1j.count} 处`);

    // 3. 模板字面量重构（多行块，自动转换，失败的提取给 LLM）
    //    必须在 ||→CONCAT 之前执行，避免 SQL 内部的 || 被错误转换
    const r3 = refactorTemplateLiterals(content);
    content = r3.content;
    fileReport.templateLiteralConverted = r3.count;
    fileReport.templateLiteralFailed = r3.failedBlocks;
    if (r3.count > 0) console.log(`  模板字面量(多行): ${r3.count} 处`);
    if (r3.failedBlocks.length > 0) console.log(`  模板字面量(需LLM): ${r3.failedBlocks.length} 个`);

    // 3b. 模板字面量转换后，清理闭合 backtick 和续行之间的 /* */ 注释块
    if (r3.count > 0) {
      const r3d = removeSqlBlockComments(content);
      content = r3d.content;
      fileReport.commentRemovals += r3d.count;
      if (r3d.count > 0) console.log(`  删除注释(模板闭合后): ${r3d.count} 处`);
    }

    // 4. 单行 SQL 拼接转模板字面量
    const r3b = convertSingleLineSql(content);
    content = r3b.content;
    fileReport.templateLiteralConverted += r3b.count;
    if (r3b.count > 0) console.log(`  模板字面量(单行): ${r3b.count} 处`);

    // 4b. 修复模板字面量残留的 " + var" 模式
    const r3c = fixResidualStringConcat(content);
    content = r3c.content;
    if (r3c.count > 0) console.log(`  修复残留" + var": ${r3c.count} 处`);

    // 4c. 清理模板字面量内的 // 注释（原始在引号内，转换后变成真正的 JS 注释）
    const r3d = removeTemplateLiteralComments(content);
    content = r3d.content;
    if (r3d.count > 0) console.log(`  清理模板内//注释: ${r3d.count} 处`);

    // 4d. 二次清理行内注释（模板转换后，原始在引号内的 // 暴露为真正的注释）
    const r3e = removeInlineComments(content, preserveLines);
    content = r3e.content;
    if (r3e.count > 0) console.log(`  二次清理//注释: ${r3e.count} 处`);

    // 4e. DECODE → CASE WHEN（自动转换，支持嵌套）
    const r3f = convertDecode(content);
    content = r3f.content;
    fileReport.decodeConversions = r3f.count;
    if (r3f.count > 0) console.log(`  DECODE→CASE WHEN: ${r3f.count} 处`);

    // 5. PIVOT → SUM(CASE WHEN ... END)
    const r4 = convertPivot(content);
    content = r4.content;
    fileReport.pivotConversions = r4.count;
    if (r4.count > 0) console.log(`  PIVOT→CASE WHEN: ${r4.count} 处`);

    // 6. || → CONCAT（仅处理模板字面量外部的 ||，跳过模板字面量内部）
    const r2 = convertConcat(content);
    content = r2.content;
    fileReport.concatConversions = r2.count;
    if (r2.count > 0) console.log(`  ||→CONCAT: ${r2.count} 处`);

    // 6b. 修复 CONCAT 内部残留的 ||
    const r2b = fixConcatInternalPipes(content);
    content = r2b.content;
    fileReport.concatPipeFixes = r2b.count;
    if (r2b.count > 0) console.log(`  修复CONCAT内部||: ${r2b.count} 处`);

    // 6c. 字符串拼接块中的 || → CONCAT（引号字符串内部的 ||）
    const r2c = convertStringConcat(content);
    content = r2c.content;
    fileReport.concatConversions += r2c.count;
    if (r2c.count > 0) console.log(`  字符串||→CONCAT: ${r2c.count} 处`);

    // 6d. FM99 格式的 TO_CHAR → FORMAT
    const r2d = convertFm99Format(content);
    content = r2d.content;
    fileReport.fm99Conversions = r2d.count;
    if (r2d.count > 0) console.log(`  FM99→FORMAT: ${r2d.count} 处`);

    // 7. 复杂模式扫描
    fileReport.complexPatterns = scanComplexPatterns(content, config.complexKeywords || []);
    if (fileReport.complexPatterns.length > 0) {
      console.log(`  复杂Oracle模式: ${fileReport.complexPatterns.length} 处`);
      const summary = {};
      fileReport.complexPatterns.forEach(p => summary[p.keyword] = (summary[p.keyword] || 0) + 1);
      console.log(`    ${JSON.stringify(summary)}`);
    }

    // 8. 最终清理：所有转换完成后再删一次行内注释（仅 SQL 块行）
    //    ||→CONCAT 等转换改变了引号结构，导致之前被保留的 // 注释暴露出来
    const r5 = removeInlineComments(content, preserveLines);
    content = r5.content;
    fileReport.commentRemovals += r5.count;
    if (r5.count > 0) console.log(`  最终清理//注释: ${r5.count} 处`);

    // 写回文件
    const hasChanges = r0.count > 0 || r0b.count > 0 || r0c.count > 0 || r1.count > 0 || r1b.count > 0 ||
                       r1c.count > 0 || r1c2.count > 0 || r1d.count > 0 ||
                       r1e.count > 0 || r1f.count > 0 || r1g.count > 0 || r1h.count > 0 || r1i.count > 0 || r1j.count > 0 ||
                       r2.count > 0 || r2b.count > 0 || r2c.count > 0 ||
                       r3.count > 0 || r3b.count > 0 || r3c.count > 0 || r3d.count > 0 || r3e.count > 0 || r3f.count > 0 || r4.count > 0 ||
                       r5.count > 0;
    if (hasChanges) {
      // 如果原始文件是 CRLF，将 LF 转换回 CRLF
      if (hasCRLF) {
        content = content.replace(/\n/g, '\r\n');
      }
      // 删除文件末尾的额外换行符
      content = content.replace(/[\r\n]+$/, '');
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`  ✓ 文件已更新`);
    } else {
      console.log(`  无变更`);
    }

    report.processedFiles.push(fileReport);
  }

  // 报告保存到技能目录
  const reportPath = path.join(__dirname, 'preprocess-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // 汇总
  const s = (key) => report.processedFiles.reduce((sum, f) => sum + f[key], 0);
  const sl = (key) => report.processedFiles.reduce((sum, f) => sum + f[key].length, 0);

  console.log('\n=== 汇总 ===');
  console.log(`删除注释: ${s('commentRemovals')} 处`);
  console.log(`简单替换: ${s('simpleReplacements')} 处`);
  console.log(`模式替换: ${s('patternReplacements')} 处`);
  console.log(`TO_CHAR→DATE_FORMAT: ${s('toCharConversions')} 处`);
  console.log(`合并跨行to_char: ${s('mergeSplitToChar')} 处`);
  console.log(`TO_CHAR→CAST AS CHAR: ${s('toCharNumberConversions')} 处`);
  console.log(`TO_DATE→STR_TO_DATE: ${s('toDateConversions')} 处`);
  console.log(`INSTR→LOCATE: ${s('instrConversions')} 处`);
  console.log(`TO_NUMBER→CAST DECIMAL: ${s('toNumberConversions')} 处`);
  console.log(`ADD_MONTHS→DATE_ADD: ${s('addMonthsConversions')} 处`);
  console.log(`MONTHS_BETWEEN→TIMESTAMPDIFF: ${s('monthsBetweenConversions')} 处`);
  console.log(`DECODE→CASE WHEN: ${s('decodeConversions')} 处`);
  console.log(`FM99→FORMAT: ${s('fm99Conversions')} 处`);
  console.log(`||→CONCAT: ${s('concatConversions')} 处`);
  console.log(`PIVOT→CASE WHEN: ${s('pivotConversions')} 处`);
  console.log(`修复swjg SQL拼接: ${s('swjgSqlFixes')} 处`);
  console.log(`模板字面量(自动): ${s('templateLiteralConverted')} 处`);
  console.log(`模板字面量(需LLM): ${sl('templateLiteralFailed')} 个`);
  console.log(`复杂Oracle模式: ${sl('complexPatterns')} 处`);
  console.log(`报告: ${reportPath}`);
}

main();
