// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      "dist/*",
      // Expo 自动生成的路由类型，不由我们维护
      ".expo/**",
      // 归档区：探索期的一次性脚本，不参与维护与 lint
      "tools/_archive/**",
    ],
  }
]);
