# AnonTranslator II

![AnonTranslator II icon](img/icon128.png)

![Preview](img/translation-preview.png)

基于 [raindrop213/AnonTranslator](https://github.com/raindrop213/AnonTranslator) 的改进版 Chrome 扩展。支持对日文网页小说、生肉阅读和本地 HTML/EPUB进行段落翻译，也支持对普通网页中的任意选中文本进行常规翻译。

这个版本添加了DeepSeek 翻译并同时进行日语假名标注、对翻译结果进行缓存的功能。

### 功能亮点

- 面向日文网页小说、本地 HTML/EPUB 和自建书库阅读场景。
- 可即时切换“日语轻小说”和“常规翻译”模式。
- 支持 Google 翻译和 DeepSeek API 翻译。
- DeepSeek 翻译可同时生成中文译文和日语假名标注。
- 支持本地缓存翻译结果，刷新页面后可复用已有译文。
- DeepSeek API Key 只保存在本机。

### 安装

1. 打开本仓库页面：[Agenlone1y2016/AnonTranslator-II](https://github.com/Agenlone1y2016/AnonTranslator-II)。
2. 点击 `Code`，选择 `Download ZIP`，解压到本地。
3. 打开 Chrome 的扩展程序页面：`chrome://extensions/`。
4. 打开右上角的 `开发者模式`。
5. 点击 `加载已解压的扩展程序`，选择解压后的项目文件夹。

也可以使用 Git：

```bash
git clone https://github.com/Agenlone1y2016/AnonTranslator-II.git
```

然后在 Chrome 中加载克隆出来的文件夹。

### DeepSeek 配置

1. 在 [DeepSeek Platform](https://platform.deepseek.com/) 创建 API Key。
2. 打开扩展设置中的 `Translator > DeepSeek`。
3. 填写 API Key，选择模型并保存。

当前支持的模型：

- `deepseek-v4-flash`
- `deepseek-v4-pro`

### 使用方式

1. 在弹窗顶部选择“日语轻小说”或“常规翻译”，切换会立即生效并自动保存。
2. 日语轻小说模式： 左键点击段落进行复制和翻译；右键点击高亮句子进行复制。
                  点击译文旁的小三角可折叠或展开；DeepSeek 会同时显示带假名标注的原文行。
3. 常规翻译模式：手动选中任意连续网页文本，点击选区旁的“译”按钮，在浮层中查看译文。
4. 在 `Translator` 中启用 `Cache Translation` 并选择 `Cache Duration`，刷新页面后可复用之前的翻译结果；`Clear Cache` 按钮可随时清除本机已保存的译文。

### 适合场景

- 在线小说站点，例如 [小説家になろう](https://syosetu.com/)、[カクヨム](https://kakuyomu.jp/)。
- 本地 HTML/EPUB 阅读页面。
- 自建书库，例如 Calibre-web。
- 其他以正文段落为主的日文阅读网页。
- 英文等其他语言的新闻、文档和普通网页文本。

### 授权与来源

本项目基于原版 AnonTranslator 修改，保留 MIT License。





![Screenshot](img/img1.png)
