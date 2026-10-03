// 宿主版本下界（实测结论：pi 0.85 无 sections / toolGuidelines，0.86 有）。
//
// 为什么钉版本：`@earendil-works/pi-coding-agent` 的 peerDependencies 必须 >= 这个值。
// 曾经的 bug 是写成 `>=0.80.5` —— 0.80~0.85 的用户装上后**静默零注入**（不报错、功能全无），
// 是最坏的一类兼容性故障。版本号在这里单点定义，package.json 的 peer 与 CI 的下界都读它。
export const MIN_PI_FOR_STRUCTURED = "0.86.0";
