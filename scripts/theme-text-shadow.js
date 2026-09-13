'use strict';

const fs = require('node:fs');

function createThemeTextShadow(file) {
  return {
    read() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')).enabled !== false; }
      catch (_) { return true; }
    },
    save(value) {
      if (!value || typeof value.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
      fs.writeFileSync(file, JSON.stringify({ enabled: value.enabled }, null, 2));
      return value.enabled;
    },
  };
}

module.exports = { createThemeTextShadow };
