/** 独立预览复用正式桌面的构建与安全配置，只更换构建期入口和输出目录。 */
import { desktopConfig } from "./electron.vite.config.js"

export default desktopConfig(true)
