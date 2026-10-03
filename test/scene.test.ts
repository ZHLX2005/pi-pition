import { describe, expect, it } from "vitest";
import { routeScene } from "../src/scene.ts";

describe("routeScene（场景路由）", () => {
  it("锻炼类输入 → train", () => {
    for (const p of [
      "我想练腰腹",
      "帮我定个锻炼计划",
      "今天跑步 5 公里",
      "我刚做完 3 组俯卧撑",
      "平板支撑还剩多少",
      "今天的目标完成得怎么样",
    ]) {
      expect(routeScene(p), p).toBe("train");
    }
  });

  it("日常记录类输入 → log（含情绪/感悟）", () => {
    for (const p of [
      "记一下今天吃了火锅",
      "刚才焦虑了一下",
      "今天心情不错",
      "中午花了 35 元点外卖",
      "突然悟到一个道理",
    ]) {
      expect(routeScene(p), p).toBe("log");
    }
  });

  it("显式翻旧账 → recall", () => {
    for (const p of ["上个月写过什么", "帮我统计一下今年的记录", "翻旧账看看去年今天"]) {
      expect(routeScene(p), p).toBe("recall");
    }
  });

  it("配置类输入 → setup", () => {
    for (const p of ["怎么配置 pition", "帮我换个库", "notion 库绑不上", "助理模式怎么开", "pition 字段说明怎么填"]) {
      expect(routeScene(p), p).toBe("setup");
    }
  });

  it("纯技术对话 → chat（不能被「配置/计划/完成」误吸走）", () => {
    for (const p of ["帮我配置一下 webpack", "解释一下什么是闭包", "这段代码报错了", "这个设计方案有什么问题"]) {
      expect(routeScene(p), p).toBe("chat");
    }
  });

  it("优先级：同句多命中时取更具体的场景（train 优先于 log）", () => {
    // 同时命中 log（今天/完成）与 train（3 组/俯卧撑）
    expect(routeScene("今天完成了 3 组俯卧撑")).toBe("train");
    // 同时命中 setup 与 train 时 setup 优先（用户此刻在配库）
    expect(routeScene("pition 还没配好，怎么设置锻炼目标")).toBe("setup");
  });

  it("粘性：低信息量消息继承上一场景，而不是跌回 chat", () => {
    expect(routeScene("好", "train")).toBe("train");
    expect(routeScene("继续", "train")).toBe("train");
    expect(routeScene("嗯嗯", "log")).toBe("log");
    expect(routeScene("", "recall")).toBe("recall");
  });

  it("粘性不吞掉新信号：低信息量后出现明确信号就切场景", () => {
    expect(routeScene("记一下今天喝了奶茶", "train")).toBe("log");
  });

  it("首轮无信号且无 prev → chat", () => {
    expect(routeScene("你好呀", undefined)).toBe("chat");
    expect(routeScene("帮我看看这段架构", undefined)).toBe("chat");
  });

  it("undefined / 空白 prompt 不抛错", () => {
    expect(routeScene(undefined as unknown as string, undefined)).toBe("chat");
    expect(routeScene("   ", "log")).toBe("log");
  });
});
