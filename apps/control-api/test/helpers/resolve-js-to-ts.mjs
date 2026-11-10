/** 測試子行程：把相對路徑的 .js 對應到同名 .ts，以便 Node type-stripping 載入原始碼。 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try { return await nextResolve(specifier.slice(0, -3) + ".ts", context); }
    catch { /* 回退到原本的 .js */ }
  }
  return nextResolve(specifier, context);
}
