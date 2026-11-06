# 两个 GitHub Actions 工作流（暂未启用）

这里的 `ci.yml` 和 `pages.yml` 是写好的 GitHub Actions 工作流，**没有**放在
`.github/workflows/` 下，因为它们推不上去：

```
! [remote rejected] main -> main (refusing to allow a Personal Access Token
  to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)
```

当前这台机器的 GitHub token 只有 `repo` 权限，改动 `.github/workflows/` 下的文件需要
额外的 `workflow` scope。要启用，二选一：

1. 重新签发一个带 `workflow` scope 的 PAT，然后
   ```bash
   mkdir -p .github/workflows
   cp docs/github-workflows/*.yml .github/workflows/
   git add .github/workflows && git commit -m "ci: 启用工作流" && git push
   ```
2. 直接在 GitHub 网页的「Add file → Create new file」里按同名路径粘贴这两份内容。

## 各自的用途

`ci.yml`：push/PR 时跑 `npm ci` → `tsc --noEmit` → `vite build`，把 `dist` 作为产物留 14 天。
浏览器自检（`tools/check.mjs`）故意没搬进来：它依赖本机 Edge/Chrome 的固定路径和
Python 语音服务，runner 上跑不出同等结果，硬跑等于假装测过。

`pages.yml`：构建带 `/<仓库名>/` 前缀的静态站并发布到 GitHub Pages。**当前发不了**：
私有仓库 + 免费账号时 API 直接返回

```
422 Your current plan does not support GitHub Pages for this repository.
```

仓库设为公开、或升级到 Pro 之后才能用。现在的主推方案是单文件 exe + Release，
见 `NOTES.md` 的「下载就能跑」一节。
