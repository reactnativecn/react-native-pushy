// 生成一个约25MB的字符串常量
const text = Array(1024 * 1024 * 5) // 5M 个元素
  .fill('这是一段用于增加打包体积的文本，包含一些随机数据：1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  .join('');

export default text; 