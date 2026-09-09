# 季付与布局增补（隔离评审稿）

目标：保持原有安全、人民币及手工记账行为，支持三个日历月季付、响应式主侧区、折叠备份和本地 SVG favicon。

步骤与结果：
1. 从宿主机显式源码清单拉取到独立 staging；不拉数据目录或登录秘密。宿主机不是 Git 仓库，本地建立源码基线便于 diff。
2. 原基线 pytest：24 passed。新增测试先运行：13 failed（季付尚未允许、页头尚未移除）。
3. 增补 validate/advance/summary 和页面；保留所有原 DOM ID、textContent 渲染与鉴权逻辑，数据库 schema 无变化。
4. 全量 pytest：37 passed；HTTP smoke：8 groups passed；Node session regression：PASS；JS syntax / git diff --check：通过。
5. 浏览器工具直接 file URL 失败后改为 about:blank 注入 staging 原 HTML/CSS，仅测布局，不连接用户预览或用户数据。1440px 主侧区为 715.25px / 420.75px；390px 单列为 362px；320px 单列为 277px；三种宽度均无横向溢出，备份默认折叠。此检查不是完整真实设备或登录流程浏览器验收。
6. 未应用宿主机、未重启/修改任何预览服务、Nginx 或防火墙。等待主 agent 独立代码评审及明确应用批准。

兼容性：JSON version=1 不变，新版可恢复旧周期与季付混合备份；旧版本不能读取含 quarterly 的备份。月份按已记录 next_date 起算，保留 anchor_day；手工指定 next_date 不回到更早季度。
