/**
 * pptx 图表部件 → ChartSpec v2 的解析测试（手工 XML，覆盖类型识别、数据缓存、
 * 堆叠变体、组合图、散点/气泡、图例与数据标签、不可识别类型）。
 */
import { describe, expect, test } from "bun:test";
import { DOMParser } from "@xmldom/xmldom";
import { readChartXml } from "../src/pptx-chart";

const parse = (xml: string) => new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;

const NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

/** 单系列 c:ser：名称 + 类目 + 数值 */
function ser(name: string, cats: (string | number)[], vals: number[]): string {
  const catPts = cats.map((c, i) => `<c:pt idx="${i}"><c:v>${c}</c:v></c:pt>`).join("");
  const valPts = vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("");
  return `<c:ser><c:idx/>${`<c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx>`}<c:cat><c:strRef><c:strCache>${catPts}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache>${valPts}</c:numCache></c:numRef></c:val></c:ser>`;
}

function space(plotArea: string, extra = ""): string {
  return `<c:chartSpace ${NS}><c:chart>${plotArea}${extra}</c:chart></c:chartSpace>`;
}

describe("readChartXml：类型与数据", () => {
  test("bar：类目/系列名/数值/系列色", () => {
    const xml = space(
      `<c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
        ${ser("销量", ["一月", "二月"], [10, 20])}
        <c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>退货</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>一月</c:v></c:pt><c:pt idx="1"><c:v>二月</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>2</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numCache></c:numRef></c:val>
          <c:spPr><a:solidFill><a:srgbClr val="0A84FF"/></a:solidFill></c:spPr>
        </c:ser>
      </c:barChart></c:plotArea>`,
    );
    const c = readChartXml(xml, parse, {});
    expect(c?.chart).toBe("bar");
    expect(c?.variant).toBe("clustered");
    expect(c?.labels).toEqual(["一月", "二月"]);
    expect(c?.series.map((s) => s.name)).toEqual(["销量", "退货"]);
    expect(c?.series[0]?.data).toEqual([10, 20]);
    expect(c?.series[1]?.color).toBe("#0A84FF");
  });

  test("barDir=bar → barH；grouping 映射 stacked / percent", () => {
    const xml = space(
      `<c:plotArea><c:barChart><c:barDir val="bar"/><c:grouping val="percentStacked"/>${ser("A", ["甲"], [1])}</c:barChart></c:plotArea>`,
    );
    const c = readChartXml(xml, parse, {});
    expect(c?.chart).toBe("barH");
    expect(c?.variant).toBe("percent");
  });

  test("line：smooth 与数据标签", () => {
    const xml = space(
      `<c:plotArea><c:lineChart><c:grouping val="standard"/>
        <c:ser><c:idx/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>一月</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val>
          <c:smooth val="1"/></c:ser>
        <c:dLbls><c:showVal val="1"/><c:dLblPos val="t"/></c:dLbls>
      </c:lineChart></c:plotArea>`,
    );
    const c = readChartXml(xml, parse, {});
    expect(c?.chart).toBe("line");
    expect(c?.smooth).toBe(true);
    expect(c?.dataLabels).toEqual({ show: true, position: "top" });
    expect(c?.variant).toBeUndefined(); // 折线不落堆叠变体字段
  });

  test("pie / doughnut：类目即扇区名", () => {
    const pie = space(`<c:plotArea><c:pieChart>${ser("占比", ["甲", "乙"], [1, 3])}</c:pieChart></c:plotArea>`);
    expect(readChartXml(pie, parse, {})?.chart).toBe("pie");
    const dn = space(`<c:plotArea><c:doughnutChart>${ser("占比", ["甲", "乙"], [1, 1])}</c:doughnutChart></c:plotArea>`);
    expect(readChartXml(dn, parse, {})?.chart).toBe("doughnut");
    expect(readChartXml(dn, parse, {})?.labels).toEqual(["甲", "乙"]);
  });

  test("radar / funnel / treemap 识别", () => {
    expect(readChartXml(space(`<c:plotArea><c:radarChart>${ser("A", ["甲", "乙"], [1, 2])}</c:radarChart></c:plotArea>`), parse, {})?.chart).toBe("radar");
    expect(readChartXml(space(`<c:plotArea><c:funnelChart>${ser("A", ["甲", "乙"], [1, 2])}</c:funnelChart></c:plotArea>`), parse, {})?.chart).toBe("funnel");
    expect(readChartXml(space(`<c:plotArea><c:treemapChart>${ser("A", ["甲", "乙"], [1, 2])}</c:treemapChart></c:plotArea>`), parse, {})?.chart).toBe("treemap");
  });
});

describe("readChartXml：特殊数据结构", () => {
  test("scatter：xVal/yVal → points（data 为空）", () => {
    const xml = space(
      `<c:plotArea><c:scatterChart><c:scatterStyle val="lineMarker"/>
        <c:ser><c:idx/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:xVal><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:xVal>
          <c:yVal><c:numRef><c:numCache><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:yVal>
        </c:ser>
      </c:scatterChart></c:plotArea>`,
    );
    const c = readChartXml(xml, parse, {});
    expect(c?.chart).toBe("scatter");
    expect(c?.series[0]?.data).toEqual([]);
    expect(c?.series[0]?.points).toEqual([{ x: 1, y: 3 }, { x: 2, y: 5 }]);
    expect(c?.labels).toEqual([]);
  });

  test("bubble：bubbleSize → point.size（最小 1）", () => {
    const xml = space(
      `<c:plotArea><c:bubbleChart>
        <c:ser><c:idx/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:xVal><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:xVal>
          <c:yVal><c:numRef><c:numCache><c:pt idx="0"><c:v>4</c:v></c:pt></c:numCache></c:numRef></c:yVal>
          <c:bubbleSize><c:numRef><c:numCache><c:pt idx="0"><c:v>0</c:v></c:pt></c:numCache></c:numRef></c:bubbleSize>
        </c:ser>
      </c:bubbleChart></c:plotArea>`,
    );
    const c = readChartXml(xml, parse, {});
    expect(c?.chart).toBe("bubble");
    expect(c?.series[0]?.points).toEqual([{ x: 1, y: 4, size: 1 }]);
  });

  test("combo：bar + line 多族 → combo，系列自带 type", () => {
    const xml = space(
      `<c:plotArea>
        <c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${ser("销量", ["一月"], [10])}</c:barChart>
        <c:lineChart><c:grouping val="standard"/>${ser("利润", ["一月"], [3])}</c:lineChart>
      </c:plotArea>`,
    );
    const c = readChartXml(xml, parse, {});
    expect(c?.chart).toBe("combo");
    expect(c?.variant).toBeUndefined();
    expect(c?.series.map((s) => s.type)).toEqual(["bar", "line"]);
  });

  test("多绘图族无法组合（bar + pie）→ 保留首族并返回告警", () => {
    const xml = space(
      `<c:plotArea>
        <c:barChart><c:barDir val="col"/>${ser("销量", ["一月"], [10])}</c:barChart>
        <c:pieChart>${ser("占比", ["一月"], [3])}</c:pieChart>
      </c:plotArea>`,
    );
    const c = readChartXml(xml, parse, {});
    expect(c?.chart).toBe("bar");
    expect(c?.series.map((s) => s.name)).toEqual(["销量"]);
    expect(c?.warnings?.[0]).toContain("pie");
  });

  test("图例：存在 c:legend 才启用，legendPos 映射方位", () => {
    const xml = space(
      `<c:plotArea><c:barChart>${ser("A", ["一月"], [1])}</c:barChart></c:plotArea>`,
      `<c:legend><c:legendPos val="r"/></c:legend>`,
    );
    expect(readChartXml(xml, parse, {})?.legend).toEqual({ show: true, position: "right" });
    const noLegend = space(`<c:plotArea><c:barChart>${ser("A", ["一月"], [1])}</c:barChart></c:plotArea>`);
    expect(readChartXml(noLegend, parse, {})?.legend).toBeUndefined();
  });

  test("不可识别类型（曲面图）→ null；空 plotArea → null", () => {
    const surface = space(`<c:plotArea><c:surfaceChart>${ser("A", ["甲"], [1])}</c:surfaceChart></c:plotArea>`);
    expect(readChartXml(surface, parse, {})).toBeNull();
    expect(readChartXml(space(`<c:plotArea/>`), parse, {})).toBeNull();
  });
});
