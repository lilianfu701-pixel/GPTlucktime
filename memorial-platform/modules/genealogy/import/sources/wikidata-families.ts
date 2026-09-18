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
// Wave 8 — 近现代艺术家 + 学者 + 实业家 + 汉宋文人。
import maodun from "./maodun.data.json";
import yanxiu from "./yanxiu.data.json";
import laoshe from "./laoshe.data.json";
import zhangjian from "./zhangjian.data.json";
import hushi from "./hushi.data.json";
import caiyuanpei from "./caiyuanpei.data.json";
import lisiguang from "./lisiguang.data.json";
import mifu from "./mifu.data.json";
import zhengxuan from "./zhengxuan.data.json";
import qibaishi from "./qibaishi.data.json";
import wuchangshuo from "./wuchangshuo.data.json";
// Wave 9 — 民国政要 + 革命先驱 + 唐代诗人 + 近现代文化名人。
import xu_zhimo from "./xu_zhimo.data.json";
import lin_yutang from "./lin_yutang.data.json";
import wang_jingwei from "./wang_jingwei.data.json";
import cai_hesen from "./cai_hesen.data.json";
import ye_jianying from "./ye_jianying.data.json";
import li_shangyin from "./li_shangyin.data.json";
import chen_lifu from "./chen_lifu.data.json";
import bai_chongxi from "./bai_chongxi.data.json";
// Wave 10 — 南北朝·隋唐文人世家 + 近现代文化名人。
import yuxin from "./yuxin.data.json";
import nalan from "./nalan.data.json";
import tian_han from "./tian_han.data.json";
import wen_yiduo from "./wen_yiduo.data.json";
import li_yu from "./li_yu.data.json";
import ouyang_xun from "./ouyang_xun.data.json";
import qin_guan from "./qin_guan.data.json";
import shen_congwen from "./shen_congwen.data.json";
import jia_yi from "./jia_yi.data.json";
// CBDB（中国历代人物传记资料库）— namespace "cbdb"，与 wikidata 各自去重。
// 补维基稀薄的深世系官宦/学术世家；数据源为繁体，见各数据集 citation。
import luyijian from "./luyijian.data.json";
import luyijian2 from "./luyijian2.data.json";
import cuixuanwei from "./cuixuanwei.data.json";
import cuiyoufu from "./cuiyoufu.data.json";
import luhuaisheng from "./luhuaisheng.data.json";
import zhengyu from "./zhengyu.data.json";
import weijian from "./weijian.data.json";
import wangbo from "./wangbo.data.json";
import xueji from "./xueji.data.json";
import peilj from "./peilj.data.json";
import weishuyu from "./weishuyu.data.json";
import yuzhining from "./yuzhining.data.json";
import suweidao from "./suweidao.data.json";
import liufen from "./liufen.data.json";
import liugong from "./liugong.data.json";
import xiaoying from "./xiaoying.data.json";
// CBDB 第三批（唐代世家 + 吴郡陆氏 + 兰陵萧氏二支 + 宋金文人）
import peiyaoqing from "./peiyaoqing.data.json";
import luguimeng from "./luguimeng.data.json";
import xiaosong from "./xiaosong.data.json";
import miaojinqing from "./miaojinqing.data.json";
import duanwenchang from "./duanwenchang.data.json";
import liuzhiji from "./liuzhiji.data.json";
import zhangjiazheng from "./zhangjiazheng.data.json";
import xujingzong from "./xujingzong.data.json";
import doudeyin from "./doudeyin.data.json";
import shangguan from "./shangguan.data.json";
import xuyougong from "./xuyougong.data.json";
import songqi from "./songqi.data.json";
import baozheng from "./baozheng.data.json";
import yuanhaowen from "./yuanhaowen.data.json";
import yujing from "./yujing.data.json";
// CBDB 第二批（宋元明宋代理学 + 唐代令狐氏 + 太原王氏）
import huangan from "./huangan.data.json";
import weiliao from "./weiliao.data.json";
import guiyouguang from "./guiyouguang.data.json";
import louyu from "./louyu.data.json";
import fangda from "./fangda.data.json";
import wucheng from "./wucheng.data.json";
import linghuchu from "./linghuchu.data.json";
import yuju from "./yuju.data.json";
import jiexi from "./jiexi.data.json";
import wangmeng from "./wangmeng.data.json";

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
  // 第八批：近现代艺术家 + 学者 + 实业家 + 汉宋文人世家。
  { key: "maodun", label: "茅盾家族（沈氏·张琴秋）", dataset: maodun as GenealogyDataset },
  { key: "yanxiu", label: "严修家族（严卞世家·天津）", dataset: yanxiu as GenealogyDataset },
  { key: "laoshe", label: "老舍家族（舒氏）", dataset: laoshe as GenealogyDataset },
  { key: "zhangjian", label: "张謇家族（南通张氏）", dataset: zhangjian as GenealogyDataset },
  { key: "hushi", label: "胡适家族", dataset: hushi as GenealogyDataset },
  { key: "caiyuanpei", label: "蔡元培家族", dataset: caiyuanpei as GenealogyDataset },
  { key: "lisiguang", label: "李四光家族", dataset: lisiguang as GenealogyDataset },
  { key: "mifu", label: "米芾家族（米友仁）", dataset: mifu as GenealogyDataset },
  { key: "zhengxuan", label: "郑玄家族（汉代经学）", dataset: zhengxuan as GenealogyDataset },
  { key: "qibaishi", label: "齐白石家族", dataset: qibaishi as GenealogyDataset },
  { key: "wuchangshuo", label: "吴昌硕家族", dataset: wuchangshuo as GenealogyDataset },
  // 第九批：民国政要 + 革命先驱 + 唐代诗人 + 近现代文化名人。
  { key: "xu_zhimo", label: "徐志摩家族（新月派·陆小曼）", dataset: xu_zhimo as GenealogyDataset },
  { key: "lin_yutang", label: "林语堂家族", dataset: lin_yutang as GenealogyDataset },
  { key: "wang_jingwei", label: "汪精卫家族（汪兆镛）", dataset: wang_jingwei as GenealogyDataset },
  { key: "cai_hesen", label: "蔡和森家族（葛健豪·蔡畅·向警予）", dataset: cai_hesen as GenealogyDataset },
  { key: "ye_jianying", label: "叶剑英家族", dataset: ye_jianying as GenealogyDataset },
  { key: "li_shangyin", label: "李商隐家族（晚唐诗人）", dataset: li_shangyin as GenealogyDataset },
  { key: "chen_lifu", label: "陈立夫家族（CC系·陈果夫）", dataset: chen_lifu as GenealogyDataset },
  { key: "bai_chongxi", label: "白崇禧家族（桂系·白先勇）", dataset: bai_chongxi as GenealogyDataset },
  // 第十批：南北朝·隋唐文人世家 + 近现代文化名人。
  { key: "yuxin", label: "庾信家族（庾肩吾·南北朝）", dataset: yuxin as GenealogyDataset },
  { key: "nalan", label: "纳兰性德家族（纳兰明珠·满洲清代）", dataset: nalan as GenealogyDataset },
  { key: "tian_han", label: "田汉家族（田大畏）", dataset: tian_han as GenealogyDataset },
  { key: "wen_yiduo", label: "闻一多家族（闻家驷）", dataset: wen_yiduo as GenealogyDataset },
  { key: "li_yu", label: "李煜家族（南唐后主·大周后）", dataset: li_yu as GenealogyDataset },
  { key: "ouyang_xun", label: "欧阳询家族（欧阳通·初唐书法）", dataset: ouyang_xun as GenealogyDataset },
  { key: "qin_guan", label: "秦观家族（秦湛·苏门四学士）", dataset: qin_guan as GenealogyDataset },
  { key: "shen_congwen", label: "沈从文家族（张兆和）", dataset: shen_congwen as GenealogyDataset },
  { key: "jia_yi", label: "贾谊家族（西汉政论）", dataset: jia_yi as GenealogyDataset },
  // CBDB 批次（namespace "cbdb"）：深世系官宦/学术世家，补维基之缺。
  // 东莱吕氏拆成两支重叠导入（各≤45人，避免单支超时导致族谱图建不全）；
  // 两支共享10人、按 CBDB id 去重后自动重连成一棵树。
  { key: "luyijian", label: "东莱吕氏·上（吕夷简·吕公著·吕希哲）", dataset: luyijian as GenealogyDataset },
  { key: "luyijian2", label: "东莱吕氏·下（吕好问·吕本中·吕祖谦）", dataset: luyijian2 as GenealogyDataset },
  { key: "cuixuanwei", label: "博陵崔氏·崔玄暐支（初唐政治家·崔渙·崔縱）", dataset: cuixuanwei as GenealogyDataset },
  { key: "cuiyoufu", label: "清河崔氏·崔祐甫支（崔沔·崔植·崔紓）", dataset: cuiyoufu as GenealogyDataset },
  { key: "luhuaisheng", label: "范阳卢氏·卢怀慎支（卢植·卢志·卢諶·卢度世）", dataset: luhuaisheng as GenealogyDataset },
  { key: "zhengyu", label: "荥阳郑氏·郑余庆支（郑鲜之·郑胤伯·郑兴·郑众）", dataset: zhengyu as GenealogyDataset },
  { key: "weijian", label: "京兆韦氏·韦坚支（韦逵·韦楷·韦邕·韦雲平）", dataset: weijian as GenealogyDataset },
  { key: "wangbo", label: "河东王氏·王勃支（王通·王福畤·初唐四杰）", dataset: wangbo as GenealogyDataset },
  { key: "xueji", label: "河东薛氏·薛稷支（薛广德·薛收·薛道衡·书画名家）", dataset: xueji as GenealogyDataset },
  { key: "peilj", label: "河东裴氏·裴寂支（裴徽·裴茂·魏晋深世系）", dataset: peilj as GenealogyDataset },
  { key: "weishuyu", label: "京兆韦氏·韦绶支（韦敻·韦世康·韦云平·第二支）", dataset: weishuyu as GenealogyDataset },
  { key: "yuzhining", label: "关中于氏·于志宁支（于洛拔·北魏到晚唐）", dataset: yuzhining as GenealogyDataset },
  { key: "suweidao", label: "赵郡苏氏·苏味道支（蘇嗣君·晚唐苏氏女支）", dataset: suweidao as GenealogyDataset },
  { key: "liufen", label: "河东柳氏·柳芬支（柳懿·柳均·南北朝到唐）", dataset: liufen as GenealogyDataset },
  { key: "liugong", label: "河东柳氏·柳公权支（书法家·柳瑗·柳仲憲）", dataset: liugong as GenealogyDataset },
  { key: "xiaoying", label: "兰陵萧氏·萧颖士支（萧道赐·萧恢·南朝到唐）", dataset: xiaoying as GenealogyDataset },
  // CBDB 第三批：唐代世家 + 吴郡陆氏 + 兰陵萧氏二支 + 宋金文人
  { key: "peiyaoqing", label: "河东裴氏·裴耀卿支（另支·北魏到晚唐·包含多支裴氏）", dataset: peiyaoqing as GenealogyDataset },
  { key: "luguimeng", label: "吴郡陆氏·陆龟蒙支（陆玩278→晚唐·追溯东晋六朝）", dataset: luguimeng as GenealogyDataset },
  { key: "xiaosong", label: "兰陵萧氏·蕭嵩支（西梁蕭詧519-562→唐代·第二支）", dataset: xiaosong as GenealogyDataset },
  { key: "miaojinqing", label: "苗氏·苗晋卿支（唐肃宗朝宰相·苗丕·苗绲）", dataset: miaojinqing as GenealogyDataset },
  { key: "duanwenchang", label: "段氏·段文昌支（段成式《酉阳杂俎》·段志玄）", dataset: duanwenchang as GenealogyDataset },
  { key: "liuzhiji", label: "彭城刘氏·刘知幾支（《史通》·南北朝到唐）", dataset: liuzhiji as GenealogyDataset },
  { key: "zhangjiazheng", label: "张氏·张嘉贞支（张彦远《历代名画记》）", dataset: zhangjiazheng as GenealogyDataset },
  { key: "xujingzong", label: "许氏·许敬宗支（许远睢阳守将·539-907）", dataset: xujingzong as GenealogyDataset },
  { key: "doudeyin", label: "扶风窦氏·竇德玄支（唐太宗皇后族·竇良矩等）", dataset: doudeyin as GenealogyDataset },
  { key: "shangguan", label: "上官氏·上官仪支（上官婉儿664-710·才女宰相）", dataset: shangguan as GenealogyDataset },
  { key: "xuyougong", label: "东海徐氏·徐有功支（追溯南北朝369年·徐逵之等）", dataset: xuyougong as GenealogyDataset },
  { key: "songqi", label: "宋氏·宋祁支（《新唐书》共撰者·998-1061）", dataset: songqi as GenealogyDataset },
  { key: "baozheng", label: "庐州包氏·包拯支（包青天·999-1062）", dataset: baozheng as GenealogyDataset },
  { key: "yuanhaowen", label: "金代元氏·元好问支（遗山先生·1190-1257）", dataset: yuanhaowen as GenealogyDataset },
  { key: "yujing", label: "南宋余氏·余靖支（庆历四谏·1000-1064）", dataset: yujing as GenealogyDataset },
  // CBDB 第二批：宋代理学/文学 + 明代文人 + 元代四大家 + 唐代贵族
  { key: "huangan", label: "湖湘胡氏·胡安国支（《春秋传》·胡宏·胡寅，1074-1138）", dataset: huangan as GenealogyDataset },
  { key: "weiliao", label: "眉山魏氏·魏了翁支（鹤山先生·南宋理学，1178-1237）", dataset: weiliao as GenealogyDataset },
  { key: "louyu", label: "明州楼氏·楼钥支（南宋名臣，1137-1213）", dataset: louyu as GenealogyDataset },
  { key: "fangda", label: "桐城方氏·方大镇支（方以智父系·明代东林，1558-1628）", dataset: fangda as GenealogyDataset },
  { key: "guiyouguang", label: "昆山归氏·归有光支（震川先生·明代散文，1506-1571）", dataset: guiyouguang as GenealogyDataset },
  { key: "wucheng", label: "崇仁吴氏·吴澄支（草庐先生·元代理学）", dataset: wucheng as GenealogyDataset },
  { key: "yuju", label: "崇仁虞氏·虞集支（元代四大家·含虞允文，1272-1348）", dataset: yuju as GenealogyDataset },
  { key: "jiexi", label: "丰城揭氏·揭傒斯支（元代四大家，1274-1344）", dataset: jiexi as GenealogyDataset },
  { key: "linghuchu", label: "唐代令狐氏·令狐楚支（令狐绹父·766-837）", dataset: linghuchu as GenealogyDataset },
  { key: "wangmeng", label: "太原王氏·王猛支（南北朝到唐·?-552到885）", dataset: wangmeng as GenealogyDataset },
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
