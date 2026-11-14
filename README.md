# 分层组织选择器的范围导出自动化

提供可展开的分层门店页面，当前浏览器入口读取区域概况，收件模块保存原始目录。

## 运行

使用 Node.js 22。依赖版本已锁定，运行、测试和演示不下载任何数据或软件。浏览器运行环境预装 Playwright 1.56.1 与 Chromium 1194；本机安装使用 `npm ci`，只在环境准备阶段执行。

- `npm test`：执行本地来源交互及收件存储测试。
- `npm run build`：逐个检查模块语法。
- `npm run demo`：启动本地来源，运行当前领取流程，打印真实收件结果后退出。
- `npm start`：在 127.0.0.1:8080 启动本地来源，PORT 可调整。`GET /health` 返回服务与当前来源版本；原有 `/_health` 仍可使用。

容器方式：`docker build -t collection-scope-tree .`，然后 `docker run --rm --network none collection-scope-tree`。镜像构建属于环境准备，运行时不访问公网。

## 项目结构

`src/domain.mjs` 提供当前业务读取入口；`src/client.mjs` 负责人工指定地址的有限大小原始领取；`src/archive.mjs` 保存内容及来源凭据。`provider/` 是独立的本地来源服务，`docs/source-contract.md` 说明它的资料和状态约定。演示使用临时目录，正式接入可向业务入口传入持久目录。

本地服务中的机构、记录和文件都是合成业务资料，不使用真实账号、个人信息或第三方站点数据。当前演示通常十秒内结束，全部本地测试应在六十秒内结束。
