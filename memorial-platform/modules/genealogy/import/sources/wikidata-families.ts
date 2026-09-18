import type { GenealogyDataset, GenealogySource } from "../types";
import soong from "./soong.data.json";
import chiang from "./chiang.data.json";
import luxun from "./luxun.data.json";
import rong from "./rong.data.json";
import qian from "./qian.data.json";
import mei from "./mei.data.json";
import bingxin from "./bingxin.data.json";
import yuan from "./yuan.data.json";
import zhangzuolin from "./zhangzuolin.data.json";
import liang from "./liang.data.json";
import lihongzhang from "./lihongzhang.data.json";
import zeng from "./zeng.data.json";
import puyi from "./puyi.data.json";
// Wave 2 — clans across more surnames and eras (ancient → modern).
import caocao from "./caocao.data.json";
import simaguang from "./simaguang.data.json";
import wangxizhi from "./wangxizhi.data.json";
import sushi from "./sushi.data.json";
import ouyangxiu from "./ouyangxiu.data.json";
import zhuxi from "./zhuxi.data.json";
import wangyangming from "./wangyangming.data.json";
import zhugeliang from "./zhugeliang.data.json";
import kongzi from "./kongzi.data.json";
import linzexu from "./linzexu.data.json";
import zuozongtang from "./zuozongtang.data.json";
import zhangzhidong from "./zhangzhidong.data.json";
import wengtonghe from "./wengtonghe.data.json";
import kangyouwei from "./kangyouwei.data.json";
import yanfu from "./yanfu.data.json";
import zhangtaiyan from "./zhangtaiyan.data.json";
import chenbaozhen from "./chenbaozhen.data.json";
import chenjiageng from "./chenjiageng.data.json";
import guomoruo from "./guomoruo.data.json";
import zhaoyuanren from "./zhaoyuanren.data.json";
// Wave 3 — more clans across the eras.
import mengzi from "./mengzi.data.json";
import simaqian from "./simaqian.data.json";
import banjia from "./banjia.data.json";
import caiyong from "./caiyong.data.json";
import xiean from "./xiean.data.json";
import taoyuanming from "./taoyuanming.data.json";
import yanzhenqing from "./yanzhenqing.data.json";
import liuzongyuan from "./liuzongyuan.data.json";
import hanyu from "./hanyu.data.json";
import fanzhongyan from "./fanzhongyan.data.json";
import wanganshi from "./wanganshi.data.json";
import yuefei from "./yuefei.data.json";
import wentianxiang from "./wentianxiang.data.json";
import luyou from "./luyou.data.json";
import zhaomengfu from "./zhaomengfu.data.json";
import zhangjuzheng from "./zhangjuzheng.data.json";
import huangzongxi from "./huangzongxi.data.json";
import guyanwu from "./guyanwu.data.json";
import zhengchenggong from "./zhengchenggong.data.json";
import jiyun from "./jiyun.data.json";
import yuanmei from "./yuanmei.data.json";
import tanyankai from "./tanyankai.data.json";
import huangxing from "./huangxing.data.json";
import liaozhongkai from "./liaozhongkai.data.json";
import xubeihong from "./xubeihong.data.json";
// Wave 4 — more clans (唐宋文人世家、明清、近代实业外交)。
import dumu from "./dumu.data.json";
import baijuyi from "./baijuyi.data.json";
import huangtingjian from "./huangtingjian.data.json";
import zenggong from "./zenggong.data.json";
import zhoudunyi from "./zhoudunyi.data.json";
import chengyi from "./chengyi.data.json";
import yanshu from "./yanshu.data.json";
import lvmengzheng from "./lvmengzheng.data.json";
import shenkuo from "./shenkuo.data.json";
import liuji from "./liuji.data.json";
import songlian from "./songlian.data.json";
import fangxiaoru from "./fangxiaoru.data.json";
import wenzhengming from "./wenzhengming.data.json";
import tangxianzu from "./tangxianzu.data.json";
import qianqianyi from "./qianqianyi.data.json";
import gongzizhen from "./gongzizhen.data.json";
import ruanyuan from "./ruanyuan.data.json";
import wangniansun from "./wangniansun.data.json";
import shengxuanhuai from "./shengxuanhuai.data.json";
import zhouxuexi from "./zhouxuexi.data.json";
import fengyoulan from "./fengyoulan.data.json";
import caoyu from "./caoyu.data.json";
import zhangjiasen from "./zhangjiasen.data.json";
import guweijun from "./guweijun.data.json";
import tangshaoyi from "./tangshaoyi.data.json";
// Wave 5 — 唐宋名臣文人 + 明清 + 近代世家。
import peidu from "./peidu.data.json";
import wangwei from "./wangwei.data.json";
import liuyuxi from "./liuyuxi.data.json";
import yuanzhen from "./yuanzhen.data.json";
import weiyingwu from "./weiyingwu.data.json";
import zhangjiuling from "./zhangjiuling.data.json";
import direnjie from "./direnjie.data.json";
import fangxuanling from "./fangxuanling.data.json";
import weizheng from "./weizheng.data.json";
import lideyu from "./lideyu.data.json";
import chusuiliang from "./chusuiliang.data.json";
import liqingzhao from "./liqingzhao.data.json";
import hanqi from "./hanqi.data.json";
import fubi from "./fubi.data.json";
import wenyanbo from "./wenyanbo.data.json";
import caixiang from "./caixiang.data.json";
import yangwanli from "./yangwanli.data.json";
import fanchengda from "./fanchengda.data.json";
import lujiuyuan from "./lujiuyuan.data.json";
import hanshizhong from "./hanshizhong.data.json";
import kouzhun from "./kouzhun.data.json";
import yeluchucai from "./yeluchucai.data.json";
import xiejin from "./xiejin.data.json";
import yansong from "./yansong.data.json";
import wangshizhen from "./wangshizhen.data.json";
import songyingxing from "./songyingxing.data.json";
import kongshangren from "./kongshangren.data.json";
import wangshizhen2 from "./wangshizhen2.data.json";
import qiandaxin from "./qiandaxin.data.json";
import yuyue from "./yuyue.data.json";
import chenduxiu from "./chenduxiu.data.json";
import qianxuantong from "./qianxuantong.data.json";
import huangyanpei from "./huangyanpei.data.json";
import chenqimei from "./chenqimei.data.json";
import lianheng from "./lianheng.data.json";
import dengjiaxian from "./dengjiaxian.data.json";
// Wave 6 — 唐宋名相 + 明清世家（桐城/太仓/东林等）。
import zhangying from "./zhangying.data.json";
import yangtinghe from "./yangtinghe.data.json";
import wangdan from "./wangdan.data.json";
import caoyin from "./caoyin.data.json";
import hanyi from "./hanyi.data.json";
import zhangjun from "./zhangjun.data.json";
import ligang from "./ligang.data.json";
import suson from "./suson.data.json";
import zenggongliang from "./zenggongliang.data.json";
import caijing from "./caijing.data.json";
import zhangyue from "./zhangyue.data.json";
import yaochong from "./yaochong.data.json";
import songjing from "./songjing.data.json";
import cenwenben from "./cenwenben.data.json";
import lishiji from "./lishiji.data.json";
import lidongyang from "./lidongyang.data.json";
import xujie from "./xujie.data.json";
import wangxijue from "./wangxijue.data.json";
import yexianggao from "./yexianggao.data.json";
import guxiancheng from "./guxiancheng.data.json";
import fanwencheng from "./fanwencheng.data.json";
import fangbao from "./fangbao.data.json";
import yaonai from "./yaonai.data.json";
import yunshouping from "./yunshouping.data.json";
import ronghong from "./ronghong.data.json";
import wutingfang from "./wutingfang.data.json";
import cenchunxuan from "./cenchunxuan.data.json";
// Wave 7 — 港台世家 + 民国政要 + 学界世家。
import hedong from "./hedong.data.json";
import guxianrong from "./guxianrong.data.json";
import lixishen from "./lixishen.data.json";
import huwenhu from "./huwenhu.data.json";
import zhouxinfang from "./zhouxinfang.data.json";
import fengyuxiang from "./fengyuxiang.data.json";
import duanqirui from "./duanqirui.data.json";
import jiangbaili from "./jiangbaili.data.json";
import zhangshizhao from "./zhangshizhao.data.json";
import lishizeng from "./lishizeng.data.json";
import wengwenhao from "./wengwenhao.data.json";
import zhoupeiyuan from "./zhoupeiyuan.data.json";

/**
 * Every Wikidata-sourced family in one registry, so wiring a new one is a single
 * import + row here rather than a bespoke loader file. All share the "wikidata"
 * identity namespace (see the datasets' `namespace`), so a person who appears in
 * two families — 蒋中正 in 宋家 and 蒋家, say — resolves to one page by QID
 * rather than a duplicate. Snapshots are produced by
 * `scripts/fetch-wikidata-family.ts` and committed for review; the import reads
 * them, so a seed never depends on Wikidata being reachable.
 *
 * Order is the curated presentation order for the admin panel.
 */
const FAMILIES: { key: string; label: string; dataset: GenealogyDataset }[] = [
  { key: "soong", label: "宋氏家族", dataset: soong as GenealogyDataset },
  { key: "chiang", label: "蒋氏家族", dataset: chiang as GenealogyDataset },
  { key: "luxun", label: "鲁迅（周氏）家族", dataset: luxun as GenealogyDataset },
  { key: "liang", label: "梁启超家族", dataset: liang as GenealogyDataset },
  { key: "lihongzhang", label: "李鸿章家族", dataset: lihongzhang as GenealogyDataset },
  { key: "zeng", label: "曾国藩家族", dataset: zeng as GenealogyDataset },
  { key: "yuan", label: "袁世凯家族", dataset: yuan as GenealogyDataset },
  { key: "zhangzuolin", label: "张作霖家族", dataset: zhangzuolin as GenealogyDataset },
  { key: "rong", label: "荣氏家族", dataset: rong as GenealogyDataset },
  { key: "qian", label: "钱氏（钱锺书）家族", dataset: qian as GenealogyDataset },
  { key: "mei", label: "梅兰芳家族", dataset: mei as GenealogyDataset },
  { key: "bingxin", label: "冰心（谢氏）家族", dataset: bingxin as GenealogyDataset },
  // 第二批：跨姓氏、跨年代的名门望族（古代 → 近现代）。
  { key: "kongzi", label: "孔子家族（直系）", dataset: kongzi as GenealogyDataset },
  { key: "zhugeliang", label: "诸葛亮家族", dataset: zhugeliang as GenealogyDataset },
  { key: "caocao", label: "曹操家族（曹魏宗室）", dataset: caocao as GenealogyDataset },
  { key: "wangxizhi", label: "王羲之家族（琅琊王氏）", dataset: wangxizhi as GenealogyDataset },
  { key: "ouyangxiu", label: "欧阳修家族", dataset: ouyangxiu as GenealogyDataset },
  { key: "simaguang", label: "司马光家族", dataset: simaguang as GenealogyDataset },
  { key: "sushi", label: "苏轼家族（眉山苏氏）", dataset: sushi as GenealogyDataset },
  { key: "zhuxi", label: "朱熹家族", dataset: zhuxi as GenealogyDataset },
  { key: "wangyangming", label: "王阳明家族（余姚王氏）", dataset: wangyangming as GenealogyDataset },
  { key: "linzexu", label: "林则徐家族", dataset: linzexu as GenealogyDataset },
  { key: "zuozongtang", label: "左宗棠家族", dataset: zuozongtang as GenealogyDataset },
  { key: "zhangzhidong", label: "张之洞家族", dataset: zhangzhidong as GenealogyDataset },
  { key: "wengtonghe", label: "翁同龢家族（常熟翁氏）", dataset: wengtonghe as GenealogyDataset },
  { key: "kangyouwei", label: "康有为家族", dataset: kangyouwei as GenealogyDataset },
  { key: "yanfu", label: "严复家族", dataset: yanfu as GenealogyDataset },
  { key: "zhangtaiyan", label: "章太炎家族", dataset: zhangtaiyan as GenealogyDataset },
  { key: "chenbaozhen", label: "陈宝箴家族（义宁陈氏）", dataset: chenbaozhen as GenealogyDataset },
  { key: "chenjiageng", label: "陈嘉庚家族", dataset: chenjiageng as GenealogyDataset },
  { key: "guomoruo", label: "郭沫若家族", dataset: guomoruo as GenealogyDataset },
  { key: "zhaoyuanren", label: "赵元任家族（常州赵氏）", dataset: zhaoyuanren as GenealogyDataset },
  // 第三批：更多姓氏、更多年代的名门（先秦 → 现代）。
  { key: "mengzi", label: "孟子家族（孟氏）", dataset: mengzi as GenealogyDataset },
  { key: "simaqian", label: "司马迁家族", dataset: simaqian as GenealogyDataset },
  { key: "banjia", label: "班固家族（班氏）", dataset: banjia as GenealogyDataset },
  { key: "caiyong", label: "蔡邕家族（蔡文姬）", dataset: caiyong as GenealogyDataset },
  { key: "xiean", label: "谢安家族（陈郡谢氏）", dataset: xiean as GenealogyDataset },
  { key: "taoyuanming", label: "陶渊明家族（浔阳陶氏）", dataset: taoyuanming as GenealogyDataset },
  { key: "yanzhenqing", label: "颜真卿家族（琅琊颜氏）", dataset: yanzhenqing as GenealogyDataset },
  { key: "liuzongyuan", label: "柳宗元家族（河东柳氏）", dataset: liuzongyuan as GenealogyDataset },
  { key: "hanyu", label: "韩愈家族", dataset: hanyu as GenealogyDataset },
  { key: "fanzhongyan", label: "范仲淹家族", dataset: fanzhongyan as GenealogyDataset },
  { key: "wanganshi", label: "王安石家族（临川王氏）", dataset: wanganshi as GenealogyDataset },
  { key: "yuefei", label: "岳飞家族", dataset: yuefei as GenealogyDataset },
  { key: "wentianxiang", label: "文天祥家族", dataset: wentianxiang as GenealogyDataset },
  { key: "luyou", label: "陆游家族（山阴陆氏）", dataset: luyou as GenealogyDataset },
  { key: "zhaomengfu", label: "赵孟頫家族", dataset: zhaomengfu as GenealogyDataset },
  { key: "zhangjuzheng", label: "张居正家族", dataset: zhangjuzheng as GenealogyDataset },
  { key: "huangzongxi", label: "黄宗羲家族（余姚黄氏）", dataset: huangzongxi as GenealogyDataset },
  { key: "guyanwu", label: "顾炎武家族", dataset: guyanwu as GenealogyDataset },
  { key: "zhengchenggong", label: "郑成功家族（郑氏）", dataset: zhengchenggong as GenealogyDataset },
  { key: "jiyun", label: "纪昀家族（纪晓岚）", dataset: jiyun as GenealogyDataset },
  { key: "yuanmei", label: "袁枚家族", dataset: yuanmei as GenealogyDataset },
  { key: "tanyankai", label: "谭延闿家族", dataset: tanyankai as GenealogyDataset },
  { key: "huangxing", label: "黄兴家族", dataset: huangxing as GenealogyDataset },
  { key: "liaozhongkai", label: "廖仲恺家族（何香凝）", dataset: liaozhongkai as GenealogyDataset },
  { key: "xubeihong", label: "徐悲鸿家族", dataset: xubeihong as GenealogyDataset },
  // 第四批：唐宋文人世家、明清、近代实业外交。
  { key: "dumu", label: "杜牧家族（京兆杜氏）", dataset: dumu as GenealogyDataset },
  { key: "baijuyi", label: "白居易家族", dataset: baijuyi as GenealogyDataset },
  { key: "huangtingjian", label: "黄庭坚家族（分宁黄氏）", dataset: huangtingjian as GenealogyDataset },
  { key: "zenggong", label: "曾巩家族（南丰曾氏）", dataset: zenggong as GenealogyDataset },
  { key: "zhoudunyi", label: "周敦颐家族", dataset: zhoudunyi as GenealogyDataset },
  { key: "chengyi", label: "二程家族（程颢程颐）", dataset: chengyi as GenealogyDataset },
  { key: "yanshu", label: "晏殊家族（晏几道）", dataset: yanshu as GenealogyDataset },
  { key: "lvmengzheng", label: "吕蒙正家族（北宋相门）", dataset: lvmengzheng as GenealogyDataset },
  { key: "shenkuo", label: "沈括家族（钱塘沈氏）", dataset: shenkuo as GenealogyDataset },
  { key: "liuji", label: "刘基家族（刘伯温）", dataset: liuji as GenealogyDataset },
  { key: "songlian", label: "宋濂家族（浦江宋氏）", dataset: songlian as GenealogyDataset },
  { key: "fangxiaoru", label: "方孝孺家族", dataset: fangxiaoru as GenealogyDataset },
  { key: "wenzhengming", label: "文徵明家族（苏州文氏）", dataset: wenzhengming as GenealogyDataset },
  { key: "tangxianzu", label: "汤显祖家族", dataset: tangxianzu as GenealogyDataset },
  { key: "qianqianyi", label: "钱谦益家族（柳如是）", dataset: qianqianyi as GenealogyDataset },
  { key: "gongzizhen", label: "龚自珍家族（段玉裁外家）", dataset: gongzizhen as GenealogyDataset },
  { key: "ruanyuan", label: "阮元家族", dataset: ruanyuan as GenealogyDataset },
  { key: "wangniansun", label: "王念孙家族（高邮王氏）", dataset: wangniansun as GenealogyDataset },
  { key: "shengxuanhuai", label: "盛宣怀家族", dataset: shengxuanhuai as GenealogyDataset },
  { key: "zhouxuexi", label: "周学熙家族（建德周氏）", dataset: zhouxuexi as GenealogyDataset },
  { key: "fengyoulan", label: "冯友兰家族（唐河冯氏）", dataset: fengyoulan as GenealogyDataset },
  { key: "caoyu", label: "曹禺家族", dataset: caoyu as GenealogyDataset },
  { key: "zhangjiasen", label: "张君劢家族（宝山张氏）", dataset: zhangjiasen as GenealogyDataset },
  { key: "guweijun", label: "顾维钧家族", dataset: guweijun as GenealogyDataset },
  { key: "tangshaoyi", label: "唐绍仪家族", dataset: tangshaoyi as GenealogyDataset },
  // 第五批：唐宋名臣文人 + 明清 + 近代世家。
  { key: "peidu", label: "裴度家族（河东裴氏）", dataset: peidu as GenealogyDataset },
  { key: "wangwei", label: "王维家族", dataset: wangwei as GenealogyDataset },
  { key: "liuyuxi", label: "刘禹锡家族", dataset: liuyuxi as GenealogyDataset },
  { key: "yuanzhen", label: "元稹家族", dataset: yuanzhen as GenealogyDataset },
  { key: "weiyingwu", label: "韦应物家族（京兆韦氏）", dataset: weiyingwu as GenealogyDataset },
  { key: "zhangjiuling", label: "张九龄家族", dataset: zhangjiuling as GenealogyDataset },
  { key: "direnjie", label: "狄仁杰家族", dataset: direnjie as GenealogyDataset },
  { key: "fangxuanling", label: "房玄龄家族", dataset: fangxuanling as GenealogyDataset },
  { key: "weizheng", label: "魏徵家族", dataset: weizheng as GenealogyDataset },
  { key: "lideyu", label: "李德裕家族（赵郡李氏）", dataset: lideyu as GenealogyDataset },
  { key: "chusuiliang", label: "褚遂良家族", dataset: chusuiliang as GenealogyDataset },
  { key: "liqingzhao", label: "李清照家族（赵明诚）", dataset: liqingzhao as GenealogyDataset },
  { key: "hanqi", label: "韩琦家族（相州韩氏）", dataset: hanqi as GenealogyDataset },
  { key: "fubi", label: "富弼家族", dataset: fubi as GenealogyDataset },
  { key: "wenyanbo", label: "文彦博家族", dataset: wenyanbo as GenealogyDataset },
  { key: "caixiang", label: "蔡襄家族", dataset: caixiang as GenealogyDataset },
  { key: "yangwanli", label: "杨万里家族", dataset: yangwanli as GenealogyDataset },
  { key: "fanchengda", label: "范成大家族", dataset: fanchengda as GenealogyDataset },
  { key: "lujiuyuan", label: "陆九渊家族", dataset: lujiuyuan as GenealogyDataset },
  { key: "hanshizhong", label: "韩世忠家族（梁红玉）", dataset: hanshizhong as GenealogyDataset },
  { key: "kouzhun", label: "寇准家族", dataset: kouzhun as GenealogyDataset },
  { key: "yeluchucai", label: "耶律楚材家族", dataset: yeluchucai as GenealogyDataset },
  { key: "xiejin", label: "解缙家族", dataset: xiejin as GenealogyDataset },
  { key: "yansong", label: "严嵩家族", dataset: yansong as GenealogyDataset },
  { key: "wangshizhen", label: "王世贞家族（太仓王氏）", dataset: wangshizhen as GenealogyDataset },
  { key: "songyingxing", label: "宋应星家族", dataset: songyingxing as GenealogyDataset },
  { key: "kongshangren", label: "孔尚任家族（曲阜孔氏）", dataset: kongshangren as GenealogyDataset },
  { key: "wangshizhen2", label: "王士禛家族（新城王氏）", dataset: wangshizhen2 as GenealogyDataset },
  { key: "qiandaxin", label: "钱大昕家族（嘉定钱氏）", dataset: qiandaxin as GenealogyDataset },
  { key: "yuyue", label: "俞樾家族（俞平伯）", dataset: yuyue as GenealogyDataset },
  { key: "chenduxiu", label: "陈独秀家族", dataset: chenduxiu as GenealogyDataset },
  { key: "qianxuantong", label: "钱玄同家族（钱三强）", dataset: qianxuantong as GenealogyDataset },
  { key: "huangyanpei", label: "黄炎培家族（川沙黄氏）", dataset: huangyanpei as GenealogyDataset },
  { key: "chenqimei", label: "陈其美家族（二陈）", dataset: chenqimei as GenealogyDataset },
  { key: "lianheng", label: "连横家族（连战）", dataset: lianheng as GenealogyDataset },
  { key: "dengjiaxian", label: "邓稼先家族（怀宁邓氏）", dataset: dengjiaxian as GenealogyDataset },
  // 第六批：唐宋名相 + 明清世家。
  { key: "zhangyue", label: "张说家族", dataset: zhangyue as GenealogyDataset },
  { key: "yaochong", label: "姚崇家族（吴兴姚氏）", dataset: yaochong as GenealogyDataset },
  { key: "songjing", label: "宋璟家族", dataset: songjing as GenealogyDataset },
  { key: "cenwenben", label: "岑文本家族（南阳岑氏·岑参）", dataset: cenwenben as GenealogyDataset },
  { key: "lishiji", label: "李勣家族", dataset: lishiji as GenealogyDataset },
  { key: "wangdan", label: "王旦家族（三槐王氏）", dataset: wangdan as GenealogyDataset },
  { key: "hanyi", label: "韩亿家族（灵寿韩氏）", dataset: hanyi as GenealogyDataset },
  { key: "suson", label: "苏颂家族", dataset: suson as GenealogyDataset },
  { key: "zenggongliang", label: "曾公亮家族（晋江曾氏）", dataset: zenggongliang as GenealogyDataset },
  { key: "caijing", label: "蔡京家族（兴化蔡氏）", dataset: caijing as GenealogyDataset },
  { key: "ligang", label: "李纲家族", dataset: ligang as GenealogyDataset },
  { key: "zhangjun", label: "张浚家族（张栻）", dataset: zhangjun as GenealogyDataset },
  { key: "yangtinghe", label: "杨廷和家族（新都杨氏·杨慎）", dataset: yangtinghe as GenealogyDataset },
  { key: "lidongyang", label: "李东阳家族", dataset: lidongyang as GenealogyDataset },
  { key: "xujie", label: "徐阶家族（松江徐氏）", dataset: xujie as GenealogyDataset },
  { key: "wangxijue", label: "王锡爵家族（太仓王氏）", dataset: wangxijue as GenealogyDataset },
  { key: "yexianggao", label: "叶向高家族（福清叶氏）", dataset: yexianggao as GenealogyDataset },
  { key: "guxiancheng", label: "顾宪成家族（东林）", dataset: guxiancheng as GenealogyDataset },
  { key: "caoyin", label: "曹寅家族（江宁织造曹家）", dataset: caoyin as GenealogyDataset },
  { key: "zhangying", label: "张英家族（桐城张氏）", dataset: zhangying as GenealogyDataset },
  { key: "fangbao", label: "方苞家族（桐城方氏）", dataset: fangbao as GenealogyDataset },
  { key: "yaonai", label: "姚鼐家族（桐城姚氏）", dataset: yaonai as GenealogyDataset },
  { key: "yunshouping", label: "恽寿平家族（常州恽氏）", dataset: yunshouping as GenealogyDataset },
  { key: "fanwencheng", label: "范文程家族（沈阳范氏）", dataset: fanwencheng as GenealogyDataset },
  { key: "cenchunxuan", label: "岑春煊家族（西林岑氏）", dataset: cenchunxuan as GenealogyDataset },
  { key: "ronghong", label: "容闳家族", dataset: ronghong as GenealogyDataset },
  { key: "wutingfang", label: "伍廷芳家族", dataset: wutingfang as GenealogyDataset },
  // 第七批：港台世家 + 民国政要 + 学界世家。
  { key: "lishizeng", label: "李石曾家族（高阳李氏）", dataset: lishizeng as GenealogyDataset },
  { key: "duanqirui", label: "段祺瑞家族", dataset: duanqirui as GenealogyDataset },
  { key: "fengyuxiang", label: "冯玉祥家族", dataset: fengyuxiang as GenealogyDataset },
  { key: "jiangbaili", label: "蒋百里家族（蒋英·钱学森）", dataset: jiangbaili as GenealogyDataset },
  { key: "zhangshizhao", label: "章士钊家族（章含之·洪晃）", dataset: zhangshizhao as GenealogyDataset },
  { key: "wengwenhao", label: "翁文灏家族", dataset: wengwenhao as GenealogyDataset },
  { key: "zhoupeiyuan", label: "周培源家族", dataset: zhoupeiyuan as GenealogyDataset },
  { key: "zhouxinfang", label: "周信芳家族（麒派）", dataset: zhouxinfang as GenealogyDataset },
  { key: "hedong", label: "何东家族（香港）", dataset: hedong as GenealogyDataset },
  { key: "guxianrong", label: "辜显荣家族（鹿港辜家）", dataset: guxianrong as GenealogyDataset },
  { key: "lixishen", label: "利希慎家族（香港利氏）", dataset: lixishen as GenealogyDataset },
  { key: "huwenhu", label: "胡文虎家族（永安堂）", dataset: huwenhu as GenealogyDataset },
  // 清皇室（溥仪）：完整世系，多为封号名，绝嗣线，人数最大——放在末尾。
  { key: "puyi", label: "清皇室（溥仪）", dataset: puyi as GenealogyDataset },
];

export type WikidataFamilyMeta = {
  key: string;
  label: string;
  people: number;
  /** Deceased people — the ones that become seeded pages (living are masked
   * graph nodes, not memorials), so "已导入 N/deceased" can reach its total. */
  deceased: number;
  photos: number;
};

/** Lightweight metadata for the admin panel — no dataset bodies. */
export const wikidataFamilyList: WikidataFamilyMeta[] = FAMILIES.map((f) => ({
  key: f.key,
  label: f.label,
  people: f.dataset.people.length,
  deceased: f.dataset.people.filter((p) => !p.living).length,
  photos: f.dataset.people.filter((p) => p.photoUrl).length,
}));

/**
 * How many deceased people of each family already have a seeded memorial, given
 * the set of imported external ids (from `importedWikidataExternalIds`). Lets
 * the admin panel show real progress per family on load.
 */
export function wikidataImportedCounts(
  importedIds: Set<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FAMILIES) {
    out[f.key] = f.dataset.people.filter(
      (p) => !p.living && importedIds.has(p.externalId),
    ).length;
  }
  return out;
}

const byKey = new Map(FAMILIES.map((f) => [f.key, f.dataset]));

/** A source for one family key, or undefined if the key is unknown. */
export function wikidataFamilySource(key: string): GenealogySource | undefined {
  const dataset = byKey.get(key);
  if (!dataset) return undefined;
  return { key: dataset.key, load: async () => dataset };
}

export const wikidataFamilyKeys: string[] = FAMILIES.map((f) => f.key);
