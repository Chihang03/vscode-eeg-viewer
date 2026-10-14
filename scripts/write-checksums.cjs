'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const files = process.argv.slice(2);
if (!files.length) throw new Error('请指定需要校验的 VSIX 文件');
const lines = files.map(file => {
  if (!file.endsWith('.vsix')) throw new Error('仅对 VSIX 安装包生成校验值');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `${hash}  ${path.basename(file)}`;
});
fs.writeFileSync('SHA256SUMS.txt', lines.join('\n') + '\n');
console.log(lines.join('\n'));
