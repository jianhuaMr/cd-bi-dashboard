# Codex 项目协议

## 循环协议

每个任务作为循环运行，不是直线：

1. 写变更。
2. 运行检查：测试 + linter + 类型检查。
3. 有失败？读错误，找原因，修它，回到第 2 步。
4. 最多循环 5 次。

## 停止条件

- 所有检查通过 -> 报告"完成"，附上通过输出作为证明。
- 5 次用完 -> 停下来，报告还剩什么没过。
- 同一个错误连续出现两次 -> 立刻停。你在猜，不是在修。

## 禁止

- 禁止：在没有检查输出的情况下报告"完成"。
- 禁止：通过删断言、弱化测试来让测试通过。修代码，不修记分牌。

## 本项目默认检查命令

```powershell
npm run check
```

如变更涉及 Cloudflare 单文件部署包，还必须额外运行：

```powershell
npm run build:single
```

如变更涉及 GitHub Pages 发布，还必须额外运行：

```powershell
npm run build:github-pages
npm run verify:static
```
