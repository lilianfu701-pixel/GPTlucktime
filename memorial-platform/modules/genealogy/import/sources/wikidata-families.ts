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
// CBDB 第三十批（明代后七子·前七子补遗·明代古文家）
import lipanlong from "./lipanlong.data.json";
import huangfuchong from "./huangfuchong.data.json";
import wuguolun from "./wuguolun.data.json";
import maokun from "./maokun.data.json";
// CBDB 第二十九批（明代前七子·明代阁臣·明代心学理学）
import yangshiqi from "./yangshiqi.data.json";
import zhanruoshui from "./zhanruoshui.data.json";
import hujuren from "./hujuren.data.json";
import gaogong from "./gaogong.data.json";
import kanghai from "./kanghai.data.json";
import biangong from "./biangong.data.json";
import xuzhengqing from "./xuzhengqing.data.json";
// CBDB 第二十八批（唐代将领·晚清重臣·清代学人）
import peixingjian from "./peixingjian.data.json";
import wangyoudun from "./wangyoudun.data.json";
import pengyuanrui from "./pengyuanrui.data.json";
import lingtingkan from "./lingtingkan.data.json";
import hulinyi from "./hulinyi.data.json";
import wangshiduo from "./wangshiduo.data.json";
import sunyjurang from "./sunyjurang.data.json";
// CBDB 第二十七批（北宋新法·南宋理学·清代学术世家）
import lvhuiqing from "./lvhuiqing.data.json";
import zhendexiu from "./zhendexiu.data.json";
import jiangtingxi from "./jiangtingxi.data.json";
import wansitong from "./wansitong.data.json";
import jiaoxun from "./jiaoxun.data.json";
import wangmingsheng from "./wangmingsheng.data.json";
import zhuyizun from "./zhuyizun.data.json";
import maoqiling from "./maoqiling.data.json";
// CBDB 第二十六批（明末清初学人志士·清初遗老）
import luxiangsheng from "./luxiangsheng.data.json";
import sunchengzong from "./sunchengzong.data.json";
import huangdaozhou from "./huangdaozhou.data.json";
import fushan from "./fushan.data.json";
// CBDB 第二十五批（明末忠义志士·晚明抗清名臣）
import niyuanlu from "./niyuanlu.data.json";
import qibiaojia from "./qibiaojia.data.json";
import xiayunyi from "./xiayunyi.data.json";
import shikefa from "./shikefa.data.json";
import zhanghuanyan from "./zhanghuanyan.data.json";
// CBDB 第二十四批（南宋权臣·明代将领·清代学者重臣）
import hantazhou from "./hantazhou.data.json";
import qijiguang from "./qijiguang.data.json";
import yuqian from "./yuqian.data.json";
import quanzuwang from "./quanzuwang.data.json";
import zenguofan from "./zenguofan.data.json";
import wengfanggang from "./wengfanggang.data.json";
import yudayou from "./yudayou.data.json";
import liangtungshu from "./liangtungshu.data.json";
import huzongxian from "./huzongxian.data.json";
import caozhengyong from "./caozhengyong.data.json";
// CBDB 第二十三批（晚唐词人·金元学者·蒙元将领）
import weizhuang from "./weizhuang.data.json";
import liuyin from "./liuyin.data.json";
import chengdunli from "./chengdunli.data.json";
import haojing from "./haojing.data.json";
import sutianjiue from "./sutianjiue.data.json";
import shitianzhuo from "./shitianzhuo.data.json";
// CBDB 第二十二批（唐代将领·北宋经学·隋唐名臣）
import wangzhongsi from "./wangzhongsi.data.json";
import sunshi from "./sunshi.data.json";
import laiji from "./laiji.data.json";
import yanjingzhi from "./yanjingzhi.data.json";
import weisili from "./weisili.data.json";
// CBDB 第二十一批（唐代经学家·五代将领·宋代词人·明代名臣）
import yanshigu from "./yanshigu.data.json";
import dushenyan from "./dushenyan.data.json";
import zhangxian from "./zhangxian.data.json";
import zhangquanyi from "./zhangquanyi.data.json";
import hairui from "./hairui.data.json";
import yeshi from "./yeshi.data.json";
// CBDB 第二十批（唐代诗人将领·南宋词人·明代画家）
import liqi from "./liqi.data.json";
import xinjiji from "./xinjiji.data.json";
import chenziang from "./chenziang.data.json";
import kongying from "./kongying.data.json";
import guoyuanzhen from "./guoyuanzhen.data.json";
import xuwu from "./xuwu.data.json";
import luzhi from "./luzhi.data.json";
import yushinan from "./yushinan.data.json";
// CBDB 第十九批（隋唐薛氏·唐代崔氏·北宋官员）
import xueshou from "./xueshou.data.json";
import cuiying from "./cuiying.data.json";
import zhouqi from "./zhouqi.data.json";
import chengzhao from "./chengzhao.data.json";
import menghan from "./menghan.data.json";
// CBDB 第十八批（南宋将领·北宋史家·宋皇族支系）
import sunying from "./sunying.data.json";
import menggong from "./menggong.data.json";
import liuban from "./liuban.data.json";
import zhaohanxiang from "./zhaohanxiang.data.json";
// CBDB 第十七批（宋明学者·朱子门人·南宋官员·明代忠臣）
import yangjishi from "./yangjishi.data.json";
import fangshinju from "./fangshinju.data.json";
import xuyefu from "./xuyefu.data.json";
import chenqi from "./chenqi.data.json";
import liuqing from "./liuqing.data.json";
import wanghao from "./wanghao.data.json";
import caiyuanding from "./caiyuanding.data.json";
import huanggan from "./huanggan.data.json";
import zhengqingzhi from "./zhengqingzhi.data.json";
// CBDB 第十六批（明代官员·学者·前七子·茶陵诗派）
import chengzhang from "./chengzhang.data.json";
import shanglu from "./shanglu.data.json";
import xieqian from "./xieqian.data.json";
import zousy from "./zousy.data.json";
import mawensheng from "./mawensheng.data.json";
import pengshi from "./pengshi.data.json";
import hejingming from "./hejingming.data.json";
import limengyang from "./limengyang.data.json";
import guling from "./guling.data.json";
// CBDB 第十五批（宋元明·学者官员·跨时代）
import songci from "./songci.data.json";
import xieshenfu from "./xieshenfu.data.json";
import xujingheng from "./xujingheng.data.json";
import huangjin from "./huangjin.data.json";
import weisguo from "./weisguo.data.json";
import yuanshuoyou from "./yuanshuoyou.data.json";
import qiujun from "./qiujun.data.json";
import shenyguan from "./shenyguan.data.json";
import liuyuan from "./liuyuan.data.json";
// CBDB 第十四批（南宋官员·将领·学者）
import luodian from "./luodian.data.json";
import wangyiwang from "./wangyiwang.data.json";
import chenkui from "./chenkui.data.json";
import penggui from "./penggui.data.json";
import zengjun from "./zengjun.data.json";
import qiaoxing from "./qiaoxing.data.json";
import linchao from "./linchao.data.json";
import shijian from "./shijian.data.json";
// CBDB 第十三批（北宋/南宋官员·文学家）
import liuziyu from "./liuziyu.data.json";
import hexuzhong from "./hexuzhong.data.json";
import yequingchen from "./yequingchen.data.json";
import jiangzhiqi from "./jiangzhiqi.data.json";
import lizhiyi from "./lizhiyi.data.json";
import zhangxiaoxiang from "./zhangxiaoxiang.data.json";
import wudafang from "./wudafang.data.json";
import liuzheng from "./liuzheng.data.json";
import qiucong from "./qiucong.data.json";
// CBDB 第十二批（五代/北宋/南宋/元代·文学官员）
import songminqiu from "./songminqiu.data.json";
import meiyaochen from "./meiyaochen.data.json";
import kongdaofu from "./kongdaofu.data.json";
import fuzhaochao from "./fuzhaochao.data.json";
import yemengde from "./yemengde.data.json";
import zhenggang from "./zhenggang.data.json";
import xuxuan from "./xuxuan.data.json";
import ouguyuan from "./ouguyuan.data.json";
import diaokan from "./diaokan.data.json";
import chengju from "./chengju.data.json";
// CBDB 第十一批（五代/北宋宰相 + 北宋名臣）
import fanzhi from "./fanzhi.data.json";
import lduoduo from "./lduoduo.data.json";
import dinwei from "./dinwei.data.json";
import xiaxong from "./xiaxong.data.json";
import caiqi from "./caiqi.data.json";
import chenzheng from "./chenzheng.data.json";
import wangqin from "./wangqin.data.json";
import sunmian from "./sunmian.data.json";
import lvshen from "./lvshen.data.json";
import shenghao from "./shenghao.data.json";
import zhangfang from "./zhangfang.data.json";
import chenruyin from "./chenruyin.data.json";
import zhaobian from "./zhaobian.data.json";
// CBDB 第十批（南宋将领/学者/宰相 + 明代文学/北宋史学）
import zhangfen from "./zhangfen.data.json";
import jiasidao from "./jiasidao.data.json";
import lixinchuan from "./lixinchuan.data.json";
import yuanxie from "./yuanxie.data.json";
import liuzai from "./liuzai.data.json";
import zhuyunming from "./zhuyunming.data.json";
import sunfu from "./sunfu.data.json";
import matingluan from "./matingluan.data.json";
import chenfuliang from "./chenfuliang.data.json";
import zhengzhong from "./zhengzhong.data.json";
import liguang from "./liguang.data.json";
// CBDB 第九批（唐宋官员/元代文人/北宋宰相）
import cuiri from "./cuiri.data.json";
import zhangyangzhao from "./zhangyangzhao.data.json";
import baipu from "./baipu.data.json";
import lianxixian from "./lianxixian.data.json";
import liangshi from "./liangshi.data.json";
import chenzhizhong from "./chenzhizhong.data.json";
import weicheng from "./weicheng.data.json";
import lvdafang from "./lvdafang.data.json";
import gaorounne from "./gaorounne.data.json";
import chengrong from "./chengrong.data.json";
// CBDB 第八批（唐宋官员/南宋词人/南宋将领/明代学者）
import quandeyu from "./quandeyu.data.json";
import hanhang from "./hanhang.data.json";
import wujie from "./wujie.data.json";
import tangshunzhi from "./tangshunzhi.data.json";
import zhaochaobi from "./zhaochaobi.data.json";
import qinshu from "./qinshu.data.json";
import zhangqixian from "./zhangqixian.data.json";
import zengzhao from "./zengzhao.data.json";
// CBDB 第七批（唐宋宰相/东汉将领/元初儒士）
import suixin from "./suixin.data.json";
import duyan from "./duyan.data.json";
import wuyuanheng from "./wuyuanheng.data.json";
import niusenru from "./niusenru.data.json";
import zhaopuchu from "./zhaopuchu.data.json";
import jiachangchao from "./jiachangchao.data.json";
import maayuan from "./maayuan.data.json";
import yaoshu from "./yaoshu.data.json";
import zhangdun from "./zhangdun.data.json";
// CBDB 第六批（北宋名臣/南宋将相/词人 + 邵雍家族）
import honghao from "./honghao.data.json";
import chengda from "./chengda.data.json";
import limixi from "./limixi.data.json";
import wangdayou from "./wangdayou.data.json";
import chenyaozuo from "./chenyaozuo.data.json";
import pangjian from "./pangjian.data.json";
import shaobowen from "./shaobowen.data.json";
import zhangshou from "./zhangshou.data.json";
import xiangziyin from "./xiangziyin.data.json";
// CBDB 第五批（南宋名臣/诗人/元代理学 + 三国张纮支）
import sumai from "./sumai.data.json";
import liuci from "./liuci.data.json";
import liukezi from "./liukezi.data.json";
import wangshipeng from "./wangshipeng.data.json";
import chenjun from "./chenjun.data.json";
import zhaokui from "./zhaokui.data.json";
import youmao from "./youmao.data.json";
import zhangshi2 from "./zhangshi2.data.json";
import chenineng from "./chenineng.data.json";
import jinlv from "./jinlv.data.json";
// CBDB 第四批（宋代名臣/元代文人/明清文人 + 欧阳修）
import shenshixing from "./shenshixing.data.json";
import yuanhongdao from "./yuanhongdao.data.json";
import sunxingyan from "./sunxingyan.data.json";
import biyuan from "./biyuan.data.json";
import yuanjie from "./yuanjie.data.json";
import hongliang from "./hongliang.data.json";
import shihao from "./shihao.data.json";
import liuguan from "./liuguan.data.json";
import zhouzhi from "./zhouzhi.data.json";
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
  // CBDB 第三十批：明代后七子·前七子补遗·明代古文家
  { key: "lipanlong", label: "历城李氏·李攀龙支（明代后七子·诗人·1514-1570·4人）", dataset: lipanlong as GenealogyDataset },
  { key: "huangfuchong", label: "长洲皇甫氏·皇甫冲支（明代苏州文人·吴中四才子旁系·1490-1558·6人）", dataset: huangfuchong as GenealogyDataset },
  { key: "wuguolun", label: "兴国吴氏·吴国伦支（明代后七子·诗人·1524-1593·4人）", dataset: wuguolun as GenealogyDataset },
  { key: "maokun", label: "归安茅氏·茅坤支（明代古文家·唐宋八大家·1512-1601·4人）", dataset: maokun as GenealogyDataset },
  // CBDB 第二十九批：明代前七子·明代阁臣·明代心学理学
  { key: "yangshiqi", label: "吉水杨氏·杨士奇支（明代三杨·内阁首辅·1365-1444·3人）", dataset: yangshiqi as GenealogyDataset },
  { key: "zhanruoshui", label: "增城湛氏·湛若水支（明代心学·甘泉学派·1466-1560·4人）", dataset: zhanruoshui as GenealogyDataset },
  { key: "hujuren", label: "余干胡氏·胡居仁支（明代理学·白鹿洞书院·1434-1484·6人）", dataset: hujuren as GenealogyDataset },
  { key: "gaogong", label: "新郑高氏·高拱支（明代内阁首辅·张居正师·1510-1578·4人）", dataset: gaogong as GenealogyDataset },
  { key: "kanghai", label: "武功康氏·康海支（明代前七子·散曲家·1475-1540·12人）", dataset: kanghai as GenealogyDataset },
  { key: "biangong", label: "历城边氏·边贡支（明代前七子·诗人·1476-1532·8人）", dataset: biangong as GenealogyDataset },
  { key: "xuzhengqing", label: "常熟徐氏·徐祯卿支（明代前七子·诗人·1479-1511·5人）", dataset: xuzhengqing as GenealogyDataset },
  // CBDB 第二十八批：唐代将领·晚清重臣·清代学人
  { key: "peixingjian", label: "河东裴氏·裴行俭支（唐代名将·619-682·含裴光庭/裴均·40人）", dataset: peixingjian as GenealogyDataset },
  { key: "wangyoudun", label: "休宁汪氏·汪由敦支（清代重臣·书法家·1692-1758·3人）", dataset: wangyoudun as GenealogyDataset },
  { key: "pengyuanrui", label: "庐陵彭氏·彭元瑞支（清代重臣·经学家·1731-1803·6人）", dataset: pengyuanrui as GenealogyDataset },
  { key: "lingtingkan", label: "滁州凌氏·凌廷堪支（清代礼学家·扬州学派·1755-1809·4人）", dataset: lingtingkan as GenealogyDataset },
  { key: "hulinyi", label: "益阳胡氏·胡林翼支（湘军将领·1812-1861·4人）", dataset: hulinyi as GenealogyDataset },
  { key: "wangshiduo", label: "江宁汪氏·汪士铎支（清代学者·幕客·1802-1889·7人）", dataset: wangshiduo as GenealogyDataset },
  { key: "sunyjurang", label: "瑞安孙氏·孙诒让支（清代经学·墨学·1848-1908·10人）", dataset: sunyjurang as GenealogyDataset },
  // CBDB 第二十七批：北宋新法·南宋理学·清代学术世家
  { key: "lvhuiqing", label: "泉州吕氏·吕惠卿支（北宋变法派·1032-1111·3人）", dataset: lvhuiqing as GenealogyDataset },
  { key: "zhendexiu", label: "浦城真氏·真德秀支（南宋理学家·1178-1235·4人）", dataset: zhendexiu as GenealogyDataset },
  { key: "jiangtingxi", label: "常熟蒋氏·蒋廷锡支（清代画家·蒋棻至蒋赐棨·1598-1802·6人）", dataset: jiangtingxi as GenealogyDataset },
  { key: "wansitong", label: "鄞县万氏·万斯同支（清初史学·万表至万斯同·1498-1702·14人）", dataset: wansitong as GenealogyDataset },
  { key: "jiaoxun", label: "甘泉焦氏·焦循支（清代扬州学派·易学家·1763-1820·16人）", dataset: jiaoxun as GenealogyDataset },
  { key: "wangmingsheng", label: "嘉定王氏·王鸣盛支（清代史学家·十七史商榷·1722-1797·5人）", dataset: wangmingsheng as GenealogyDataset },
  { key: "zhuyizun", label: "秀水朱氏·朱彝尊支（清代词人·金石学·1629-1709·3人）", dataset: zhuyizun as GenealogyDataset },
  { key: "maoqiling", label: "萧山毛氏·毛奇龄支（清代经学家·1623-1716·3人）", dataset: maoqiling as GenealogyDataset },
  // CBDB 第二十六批：明末清初学人志士·清初遗老
  { key: "luxiangsheng", label: "宜兴卢氏·卢象升支（明末抗清将领·1600-1638·3人）", dataset: luxiangsheng as GenealogyDataset },
  { key: "sunchengzong", label: "高阳孙氏·孙承宗支（明代督师·1563-1638·4人）", dataset: sunchengzong as GenealogyDataset },
  { key: "huangdaozhou", label: "漳浦黄氏·黄道周支（明末忠臣·书法家·1585-1646·3人）", dataset: huangdaozhou as GenealogyDataset },
  { key: "fushan", label: "阳曲傅氏·傅山支（清初思想家·书画家·1602-1683·3人）", dataset: fushan as GenealogyDataset },
  // CBDB 第二十五批：明末忠义志士·晚明抗清名臣
  { key: "niyuanlu", label: "上虞倪氏·倪元璐支（明末忠臣·书画家·1593-1644·14人）", dataset: niyuanlu as GenealogyDataset },
  { key: "qibiaojia", label: "山阴祁氏·祁彪佳支（明末官员·寓山园·1602-1645·16人）", dataset: qibiaojia as GenealogyDataset },
  { key: "xiayunyi", label: "松江夏氏·夏允彝支（明末忠臣·夏完淳之父·1596-1645·5人）", dataset: xiayunyi as GenealogyDataset },
  { key: "shikefa", label: "祥符史氏·史可法支（明末督师·扬州殉国·1602-1645·3人）", dataset: shikefa as GenealogyDataset },
  { key: "zhanghuanyan", label: "鄞县张氏·张煌言支（明末抗清将领·1620-1664·4人）", dataset: zhanghuanyan as GenealogyDataset },
  // CBDB 第二十四批：南宋权臣·明代将领·清代学者重臣
  { key: "hantazhou", label: "颍川韩氏·韩侂胄支（南宋权臣·1152-1207·3人）", dataset: hantazhou as GenealogyDataset },
  { key: "qijiguang", label: "定远戚氏·戚继光支（明代抗倭名将·1528-1587·3人）", dataset: qijiguang as GenealogyDataset },
  { key: "yuqian", label: "钱塘于氏·于谦支（明代名臣·北京保卫战·1398-1457·3人）", dataset: yuqian as GenealogyDataset },
  { key: "quanzuwang", label: "鄞县全氏·全祖望支（清代史学家·1705-1755·6人）", dataset: quanzuwang as GenealogyDataset },
  { key: "zenguofan", label: "湘乡曾氏·曾国藩支（晚清重臣·1811-1872·4人）", dataset: zenguofan as GenealogyDataset },
  { key: "wengfanggang", label: "大兴翁氏·翁方纲支（清代书法家·金石学家·1733-1818·6人）", dataset: wengfanggang as GenealogyDataset },
  { key: "yudayou", label: "晋江俞氏·俞大猷支（明代抗倭将领·1503-1579·3人）", dataset: yudayou as GenealogyDataset },
  { key: "liangtungshu", label: "钱塘梁氏·梁同书支（清代书法家·1723-1815·3人）", dataset: liangtungshu as GenealogyDataset },
  { key: "huzongxian", label: "绩溪胡氏·胡宗宪支（明代抗倭总督·?-1565·5人）", dataset: huzongxian as GenealogyDataset },
  { key: "caozhengyong", label: "歙县曹氏·曹振镛支（清代宰相·1755-1835·5人）", dataset: caozhengyong as GenealogyDataset },
  // CBDB 第二十三批：晚唐词人·金元学者·蒙元将领
  { key: "weizhuang", label: "京兆韦氏·韦庄支（晚唐词人·花间集·836-910·含韦应物·9人）", dataset: weizhuang as GenealogyDataset },
  { key: "liuyin", label: "蠡州刘氏·刘因支（元代儒学家·静修先生·1249-1293·4人）", dataset: liuyin as GenealogyDataset },
  { key: "chengdunli", label: "饶州程氏·程端礼支（元代教育家·1271-1345·4人）", dataset: chengdunli as GenealogyDataset },
  { key: "haojing", label: "陵川郝氏·郝经支（金元之际学者·1223-1275·13人）", dataset: haojing as GenealogyDataset },
  { key: "sutianjiue", label: "真定苏氏·苏天爵支（元代史学家·1294-1352·8人）", dataset: sutianjiue as GenealogyDataset },
  { key: "shitianzhuo", label: "真定史氏·史天泽支（蒙元名将·1202-1275·13人）", dataset: shitianzhuo as GenealogyDataset },
  // CBDB 第二十二批：唐代将领·北宋经学·隋唐名臣
  { key: "wangzhongsi", label: "太原王氏·王忠嗣支（唐代名将·节度四镇·731-775·8人）", dataset: wangzhongsi as GenealogyDataset },
  { key: "sunshi", label: "博州孙氏·孙奭支（北宋经学家·962-1033·5人）", dataset: sunshi as GenealogyDataset },
  { key: "laiji", label: "江都来氏·来济支（唐代宰相·610-662·6人）", dataset: laiji as GenealogyDataset },
  { key: "yanjingzhi", label: "华阴严氏·严挺之支（唐代官员·严武之父·?-748·7人）", dataset: yanjingzhi as GenealogyDataset },
  { key: "weisili", label: "京兆韦氏·韦嗣立支（唐代官员·654-719·23人）", dataset: weisili as GenealogyDataset },
  // CBDB 第二十一批：唐代经学家·五代将领·宋代词人·明代名臣
  { key: "yanshigu", label: "京兆颜氏·颜师古支（唐代经学家·颜氏家训家族·581-645·25人）", dataset: yanshigu as GenealogyDataset },
  { key: "dushenyan", label: "京兆杜氏·杜审言支（唐代诗人·杜甫祖父·645-708·15人）", dataset: dushenyan as GenealogyDataset },
  { key: "zhangxian", label: "乌程张氏·张先支（北宋词人·影字三绝·990-1078·14人）", dataset: zhangxian as GenealogyDataset },
  { key: "zhangquanyi", label: "河阳张氏·张全义支（五代名将·洛阳重建者·851-926·9人）", dataset: zhangquanyi as GenealogyDataset },
  { key: "hairui", label: "琼山海氏·海瑞支（明代清官·1514-1587·7人）", dataset: hairui as GenealogyDataset },
  { key: "yeshi", label: "永嘉叶氏·叶适支（南宋学者·永嘉学派·1150-1223·4人）", dataset: yeshi as GenealogyDataset },
  // CBDB 第二十批：唐代诗人将领·南宋词人·明代画家
  { key: "liqi", label: "赵郡李氏·李峤支（唐代诗人·官员·645-714·34人）", dataset: liqi as GenealogyDataset },
  { key: "xinjiji", label: "历城辛氏·辛弃疾支（南宋词人·抗金将领·1140-1207·22人）", dataset: xinjiji as GenealogyDataset },
  { key: "chenziang", label: "射洪陈氏·陈子昂支（唐代诗人·661-702·10人）", dataset: chenziang as GenealogyDataset },
  { key: "kongying", label: "冀州孔氏·孔颖达支（唐代经学家·五经正义·574-648·10人）", dataset: kongying as GenealogyDataset },
  { key: "guoyuanzhen", label: "魏州郭氏·郭元振支（唐代名将·开元功臣·?-722·8人）", dataset: guoyuanzhen as GenealogyDataset },
  { key: "xuwu", label: "绍兴徐氏·徐渭支（明代画家·文人·1521-1593·6人）", dataset: xuwu as GenealogyDataset },
  { key: "luzhi", label: "嘉兴陆氏·陆贽支（唐代名相·贞元宰相·754-805·5人）", dataset: luzhi as GenealogyDataset },
  { key: "yushinan", label: "越州虞氏·虞世南支（唐代书法家·初唐四友·558-638·3人）", dataset: yushinan as GenealogyDataset },
  // CBDB 第十九批：隋唐薛氏·唐代崔氏·北宋官员
  { key: "xueshou", label: "河东薛氏·薛收支（隋末唐初官员·592-624·45人）", dataset: xueshou as GenealogyDataset },
  { key: "cuiying", label: "博陵崔氏·崔瑛支（唐代官员·702-728）", dataset: cuiying as GenealogyDataset },
  { key: "zhouqi", label: "汝南周氏·周起支（北宋官员·970-1028）", dataset: zhouqi as GenealogyDataset },
  { key: "chengzhao", label: "新安程氏·程昭支（宋代官员·多代记录）", dataset: chengzhao as GenealogyDataset },
  { key: "menghan", label: "宋代孟氏·孟漢支（宋代官员·多代记录）", dataset: menghan as GenealogyDataset },
  // CBDB 第十八批：南宋将领·北宋史家·宋皇族支系
  { key: "zhaohanxiang", label: "鄞县赵氏·赵善湘支（南宋官员·宁宗朝宰相·1167-1246·27人）", dataset: zhaohanxiang as GenealogyDataset },
  { key: "liuban", label: "新喻刘氏·刘攽支（北宋史学家·资治通鉴编者·1023-1089·16人）", dataset: liuban as GenealogyDataset },
  { key: "menggong", label: "随州孟氏·孟珙支（南宋名将·保卫荆楚·1195-1246）", dataset: menggong as GenealogyDataset },
  { key: "sunying", label: "宋代孙氏·孙应支（宋代官员·多代记录）", dataset: sunying as GenealogyDataset },
  // CBDB 第十七批：宋明学者·朱子门人·南宋官员·明代忠臣
  { key: "caiyuanding", label: "建阳蔡氏·蔡元定支（朱子友人·律历学家·1135-1198·16人）", dataset: caiyuanding as GenealogyDataset },
  { key: "huanggan", label: "闽县黄氏·黄干支（朱子女婿·闽学传人·1152-1221）", dataset: huanggan as GenealogyDataset },
  { key: "zhengqingzhi", label: "鄞县郑氏·郑清之支（南宋宰相·1176-1251）", dataset: zhengqingzhi as GenealogyDataset },
  { key: "fangshinju", label: "兴化方氏·方信孺支（南宋外交家·使金名臣·1177-1222）", dataset: fangshinju as GenealogyDataset },
  { key: "xuyefu", label: "宣城许氏·许有孚支（元代官员·诗人·14世纪）", dataset: xuyefu as GenealogyDataset },
  { key: "wanghao", label: "锦州王氏·王翺支（明代名臣·成化三朝元老·1384-1467）", dataset: wanghao as GenealogyDataset },
  { key: "liuqing", label: "明代刘氏·刘清支（明代官员·1432-）", dataset: liuqing as GenealogyDataset },
  { key: "yangjishi", label: "容城杨氏·杨继盛支（明代忠臣·抗严嵩·1516-1555）", dataset: yangjishi as GenealogyDataset },
  { key: "chenqi", label: "明代陈氏·陈琦支（明末官员·1579-）", dataset: chenqi as GenealogyDataset },
  // CBDB 第十六批：明代官员·学者·前七子·茶陵诗派
  { key: "chengzhang", label: "庐陵程氏·程钜夫支（元代官员·翰林学士·1249-1318）", dataset: chengzhang as GenealogyDataset },
  { key: "shanglu", label: "茶陵商氏·商辂支（明代宰相·三元及第·1414-1486）", dataset: shanglu as GenealogyDataset },
  { key: "xieqian", label: "余姚谢氏·谢迁支（明代宰相·弘治三君子·1449-1531）", dataset: xieqian as GenealogyDataset },
  { key: "zousy", label: "安福邹氏·邹守益支（明代学者·王学左派·1491-1562）", dataset: zousy as GenealogyDataset },
  { key: "mawensheng", label: "钧州马氏·马文升支（明代名臣·成化弘治兵部尚书·1426-1510）", dataset: mawensheng as GenealogyDataset },
  { key: "pengshi", label: "安福彭氏·彭时支（明代名臣·天顺状元·1416-1475）", dataset: pengshi as GenealogyDataset },
  { key: "hejingming", label: "信阳何氏·何景明支（明代诗人·前七子·1483-1521）", dataset: hejingming as GenealogyDataset },
  { key: "limengyang", label: "庆阳李氏·李梦阳支（明代诗人·前七子领袖·1473-1530）", dataset: limengyang as GenealogyDataset },
  { key: "guling", label: "华亭顾氏·顾璘支（明代诗人·金陵文坛领袖·1476-1545）", dataset: guling as GenealogyDataset },
  // CBDB 第十五批：宋元明学者官员
  { key: "songci", label: "建阳宋氏·宋慈支（南宋法医学家·《洗冤集录》·1186-1249）", dataset: songci as GenealogyDataset },
  { key: "xieshenfu", label: "剡县谢氏·谢深甫支（南宋宰相·谢道清祖父·1139-1204）", dataset: xieshenfu as GenealogyDataset },
  { key: "xujingheng", label: "瑞安许氏·许景衡支（北宋/南宋官员·1072-1128）", dataset: xujingheng as GenealogyDataset },
  { key: "huangjin", label: "义乌黄氏·黄溍支（元代史学家·文学家·1277-1357）", dataset: huangjin as GenealogyDataset },
  { key: "weisguo", label: "抚州危氏·危素支（元代官员·文学家·1303-1372）", dataset: weisguo as GenealogyDataset },
  { key: "yuanshuoyou", label: "建安袁氏·袁说友支（南宋官员·1140-1204）", dataset: yuanshuoyou as GenealogyDataset },
  { key: "qiujun", label: "琼山丘氏·丘濬支（明代学者·《大学衍义补》·1418-1495）", dataset: qiujun as GenealogyDataset },
  { key: "shenyguan", label: "鄞县沈氏·沈一贯支（明代宰相·1531-1615）", dataset: shenyguan as GenealogyDataset },
  { key: "liuyuan", label: "唐代刘氏·刘源支（唐代官员·多代记录）", dataset: liuyuan as GenealogyDataset },
  // CBDB 第十四批：南宋官员·将领·学者
  { key: "luodian", label: "豫章罗氏·罗点支（南宋官员·直言进谏·1150-1194）", dataset: luodian as GenealogyDataset },
  { key: "wangyiwang", label: "开封王氏·王之望支（南宋官员·和戎大臣·1102-1170）", dataset: wangyiwang as GenealogyDataset },
  { key: "chenkui", label: "温州陈氏·陈骙支（南宋宰相·文史学家·1128-1203）", dataset: chenkui as GenealogyDataset },
  { key: "penggui", label: "安福彭氏·彭龟年支（南宋官员·道学家·1142-1206）", dataset: penggui as GenealogyDataset },
  { key: "zengjun", label: "赣州曾氏·曾几支（南宋诗人·茶山先生·1084-1166）", dataset: zengjun as GenealogyDataset },
  { key: "qiaoxing", label: "天台乔氏·乔行简支（南宋宰相·1156-1241）", dataset: qiaoxing as GenealogyDataset },
  { key: "linchao", label: "莆田林氏·林光朝支（南宋学者·澹轩先生·1114-1178）", dataset: linchao as GenealogyDataset },
  { key: "shijian", label: "明州史氏·史渐支（南宋官员·史嵩之曾祖·38人）", dataset: shijian as GenealogyDataset },
  // CBDB 第十三批：北宋/南宋官员·文学家
  { key: "liuziyu", label: "崇安刘氏·刘子羽支（南宋将领·刘珙之父·1096-1146）", dataset: liuziyu as GenealogyDataset },
  { key: "hexuzhong", label: "仙游何氏·何执中支（北宋宰相·1044-1117）", dataset: hexuzhong as GenealogyDataset },
  { key: "yequingchen", label: "苏州叶氏·叶清臣支（北宋官员·1000-1049）", dataset: yequingchen as GenealogyDataset },
  { key: "jiangzhiqi", label: "宜兴蒋氏·蒋之奇支（北宋官员·1031-1104）", dataset: jiangzhiqi as GenealogyDataset },
  { key: "lizhiyi", label: "沧州李氏·李之仪支（北宋词人·1038-1117）", dataset: lizhiyi as GenealogyDataset },
  { key: "zhangxiaoxiang", label: "历阳张氏·张孝祥支（南宋词人·书法家·1132-1170）", dataset: zhangxiaoxiang as GenealogyDataset },
  { key: "wudafang", label: "台州吴氏·吴芾支（南宋官员·1104-1183）", dataset: wudafang as GenealogyDataset },
  { key: "liuzheng", label: "泉州留氏·留正支（南宋宰相·1129-1206）", dataset: liuzheng as GenealogyDataset },
  { key: "qiucong", label: "兴化丘氏·丘崈支（南宋官员·1135-1208）", dataset: qiucong as GenealogyDataset },
  // CBDB 第十二批：五代/北宋/南宋/元代文学官员
  { key: "songminqiu", label: "京兆宋氏·宋敏求支（北宋史学家·档案学家·1019-1079）", dataset: songminqiu as GenealogyDataset },
  { key: "meiyaochen", label: "宣城梅氏·梅尧臣支（北宋诗人·宛陵先生·1002-1060）", dataset: meiyaochen as GenealogyDataset },
  { key: "kongdaofu", label: "曲阜孔氏·孔道辅支（北宋官员·孔子后裔·990-1041）", dataset: kongdaofu as GenealogyDataset },
  { key: "fuzhaochao", label: "遂州傅氏·傅尧俞支（北宋官员·直言敢谏·1024-1091）", dataset: fuzhaochao as GenealogyDataset },
  { key: "yemengde", label: "丹阳叶氏·叶梦得支（南宋词人·避暑录话·1077-1148）", dataset: yemengde as GenealogyDataset },
  { key: "zhenggang", label: "浦江郑氏·郑刚中支（南宋官员·书写北事·1088-1154）", dataset: zhenggang as GenealogyDataset },
  { key: "xuxuan", label: "广陵徐氏·徐铉支（五代/北宋书法家·916-991）", dataset: xuxuan as GenealogyDataset },
  { key: "ouguyuan", label: "庐陵欧阳氏·欧阳玄支（元代学者/文学家·1283-1357）", dataset: ouguyuan as GenealogyDataset },
  { key: "diaokan", label: "渤海刁氏·刁衎支（五代/北宋官员·903-970）", dataset: diaokan as GenealogyDataset },
  { key: "chengju", label: "吴兴程氏·程俱支（南宋官员/文学家·1078-1144）", dataset: chengju as GenealogyDataset },
  // CBDB 第十一批：五代/北宋宰相 + 北宋名臣
  { key: "fanzhi", label: "范阳范氏·范质支（五代/北宋宰相·911-964）", dataset: fanzhi as GenealogyDataset },
  { key: "lduoduo", label: "范阳卢氏·卢多逊支（北宋宰相·934-985）", dataset: lduoduo as GenealogyDataset },
  { key: "dinwei", label: "苏州丁氏·丁谓支（北宋宰相·966-1037）", dataset: dinwei as GenealogyDataset },
  { key: "xiaxong", label: "德安夏氏·夏竦支（北宋宰相/文学家·985-1051）", dataset: xiaxong as GenealogyDataset },
  { key: "caiqi", label: "莱州蔡氏·蔡齐支（北宋宰相·988-1039）", dataset: caiqi as GenealogyDataset },
  { key: "chenzheng", label: "抚州陈氏·陈升之支（北宋宰相·1011-1079）", dataset: chenzheng as GenealogyDataset },
  { key: "wangqin", label: "临江王氏·王钦若支（北宋宰相·962-1025）", dataset: wangqin as GenealogyDataset },
  { key: "sunmian", label: "邵武孙氏·孙沔支（北宋官员·999-1063）", dataset: sunmian as GenealogyDataset },
  { key: "lvshen", label: "汲郡吕氏·吕申支（北宋官员·5人）", dataset: lvshen as GenealogyDataset },
  { key: "shenghao", label: "金华盛氏·盛度支（北宋官员·966-1041）", dataset: shenghao as GenealogyDataset },
  { key: "zhangfang", label: "应天张氏·张方平支（北宋官员/文学家·1007-1091）", dataset: zhangfang as GenealogyDataset },
  { key: "chenruyin", label: "吴兴陈氏·陈汝言支（元代书画家·12人）", dataset: chenruyin as GenealogyDataset },
  { key: "zhaobian", label: "衢州赵氏·赵抃支（北宋名臣·铁面御史·1008-1084）", dataset: zhaobian as GenealogyDataset },
  // CBDB 第十批：南宋将领/学者/宰相 + 明代文学 + 北宋史学
  { key: "zhangfen", label: "建安章氏·章楶支（北宋将领·边防官员·1027-1102）", dataset: zhangfen as GenealogyDataset },
  { key: "jiasidao", label: "天水贾氏·贾似道支（南宋宰相·1213-1275）", dataset: jiasidao as GenealogyDataset },
  { key: "lixinchuan", label: "井研李氏·李心传支（南宋史学家·《建炎以来朝野杂记》）", dataset: lixinchuan as GenealogyDataset },
  { key: "yuanxie", label: "四明袁氏·袁燮支（南宋理学家·象山弟子·1144-1224）", dataset: yuanxie as GenealogyDataset },
  { key: "liuzai", label: "金坛刘氏·刘宰支（南宋学者·1167-1240）", dataset: liuzai as GenealogyDataset },
  { key: "zhuyunming", label: "长洲祝氏·祝允明支（明代书法家·吴中四才子·1461-1527）", dataset: zhuyunming as GenealogyDataset },
  { key: "sunfu", label: "深州孙氏·孙甫支（北宋史学家·992-1057）", dataset: sunfu as GenealogyDataset },
  { key: "matingluan", label: "饶州马氏·马廷鸾支（南宋宰相·马端临之父·1223-1289）", dataset: matingluan as GenealogyDataset },
  { key: "chenfuliang", label: "瑞安陈氏·陈傅良支（南宋学者·永嘉学派·1137-1203）", dataset: chenfuliang as GenealogyDataset },
  { key: "zhengzhong", label: "郑州郑氏·郑居中支（北宋宰相·1059-1123）", dataset: zhengzhong as GenealogyDataset },
  { key: "liguang", label: "越州李氏·李光支（南宋官员·抗金大臣·1078-1159）", dataset: liguang as GenealogyDataset },
  // CBDB 第九批：唐宋官员 + 元代文人 + 北宋宰相
  { key: "cuiri", label: "博陵崔氏·崔日用支（唐代宰相·官至工部尚书·？-716）", dataset: cuiri as GenealogyDataset },
  { key: "zhangyangzhao", label: "济南张氏·张养浩支（元代散曲大家·1269-1329）", dataset: zhangyangzhao as GenealogyDataset },
  { key: "baipu", label: "金元白氏·白朴支（元曲四大家·1226-1306）", dataset: baipu as GenealogyDataset },
  { key: "lianxixian", label: "维吾尔廉氏·廉希宪支（元代宰相·布鲁海牙之后·1231-1280）", dataset: lianxixian as GenealogyDataset },
  { key: "liangshi", label: "郓州梁氏·梁适支（北宋宰相·979-1052）", dataset: liangshi as GenealogyDataset },
  { key: "chenzhizhong", label: "沧州陈氏·陈执中支（北宋宰相·990-1059）", dataset: chenzhizhong as GenealogyDataset },
  { key: "weicheng", label: "京兆韦氏·韦澄支（唐代官员·韦承彦后裔·45人）", dataset: weicheng as GenealogyDataset },
  { key: "lvdafang", label: "冯翊吕氏·吕大防支（北宋宰相·1027-1097）", dataset: lvdafang as GenealogyDataset },
  { key: "gaorounne", label: "幽州高氏·高若讷支（北宋官员·997-1055）", dataset: gaorounne as GenealogyDataset },
  { key: "chengrong", label: "博野程氏·程琳支（北宋官员·988-1056）", dataset: chengrong as GenealogyDataset },
  // CBDB 第八批：唐宋官员 + 南宋将领 + 明代学者 + 北宋宰相
  { key: "quandeyu", label: "天水权氏·权德舆支（唐代宰相/文学家·759-818）", dataset: quandeyu as GenealogyDataset },
  { key: "hanhang", label: "京兆韩氏·韩滉支（唐代官员·韩休之子·723-787）", dataset: hanhang as GenealogyDataset },
  { key: "wujie", label: "德顺吴氏·吴玠支（南宋抗金将领·1093-1139）", dataset: wujie as GenealogyDataset },
  { key: "tangshunzhi", label: "武进唐氏·唐顺之支（明代学者·荆川先生·1507-1560）", dataset: tangshunzhi as GenealogyDataset },
  { key: "zhaochaobi", label: "济州晁氏·晁补之支（北宋文人·苏门四学士·1053-1110）", dataset: zhaochaobi as GenealogyDataset },
  { key: "qinshu", label: "无锡秦氏·秦桧支（南宋宰相·绍兴和议·1090-1155）", dataset: qinshu as GenealogyDataset },
  { key: "zhangqixian", label: "洛阳张氏·张齐贤支（北宋宰相·942-1014）", dataset: zhangqixian as GenealogyDataset },
  { key: "zengzhao", label: "南丰曾氏·曾肇支（北宋官员·曾巩之弟·1047-1107）", dataset: zengzhao as GenealogyDataset },
  // CBDB 第七批：唐宋宰相 + 东汉将领 + 元初儒士
  { key: "suixin", label: "武功苏氏·苏颋支（苏威→苏绰→苏颋·隋唐宰相·670-727）", dataset: suixin as GenealogyDataset },
  { key: "duyan", label: "越州杜氏·杜衍支（北宋宰相·含杜祁公·978-1057）", dataset: duyan as GenealogyDataset },
  { key: "wuyuanheng", label: "河南武氏·武元衡支（中唐宰相·被刺·758-815）", dataset: wuyuanheng as GenealogyDataset },
  { key: "niusenru", label: "安定牛氏·牛僧孺支（牛李党争·牛峤祖·779-848）", dataset: niusenru as GenealogyDataset },
  { key: "zhaopuchu", label: "幽州赵氏·赵普支（宋初宰相·半部论语治天下·922-992）", dataset: zhaopuchu as GenealogyDataset },
  { key: "jiachangchao", label: "沧州贾氏·贾昌朝支（北宋宰相·997-1065）", dataset: jiachangchao as GenealogyDataset },
  { key: "maayuan", label: "茂陵马氏·马援支（东汉伏波将军·马革裹尸·14BCE-49CE）", dataset: maayuan as GenealogyDataset },
  { key: "yaoshu", label: "营州姚氏·姚枢支（元初儒士·1201-1278）", dataset: yaoshu as GenealogyDataset },
  { key: "zhangdun", label: "浦城章氏·章惇支（北宋宰相·绍圣改革·1035-1105）", dataset: zhangdun as GenealogyDataset },
  // CBDB 第六批：北宋名臣/南宋将相/词人 + 邵雍家族
  { key: "honghao", label: "鄱阳洪氏·洪皓支（南宋使金·洪适洪迈父·1088-1155）", dataset: honghao as GenealogyDataset },
  { key: "chengda", label: "休宁程氏·程大昌支（宋代文学家·1123-1195）", dataset: chengda as GenealogyDataset },
  { key: "limixi", label: "连江李氏·李弥逊支（南宋词人官员·1085-1153）", dataset: limixi as GenealogyDataset },
  { key: "wangdayou", label: "鄞县汪氏·汪大猷支（南宋官员·1138-1201）", dataset: wangdayou as GenealogyDataset },
  { key: "chenyaozuo", label: "阆中陈氏·陈尧佐支（北宋宰相·含陈尧咨·963-1044）", dataset: chenyaozuo as GenealogyDataset },
  { key: "pangjian", label: "单州庞氏·庞籍支（北宋宰相·庞谦孺·988-1063）", dataset: pangjian as GenealogyDataset },
  { key: "shaobowen", label: "共城邵氏·邵伯温支（含邵雍北宋五子·1011-1134）", dataset: shaobowen as GenealogyDataset },
  { key: "zhangshou", label: "庆元张氏·张守支（南宋官员·1084-1145）", dataset: zhangshou as GenealogyDataset },
  { key: "xiangziyin", label: "开封向氏·向子諲支（南宋词人·含向敏中·1085-1152）", dataset: xiangziyin as GenealogyDataset },
  // CBDB 第五批：南宋名臣/诗人/元代理学 + 三国张纮支
  { key: "sumai", label: "眉山苏氏·苏迈支（苏轼长子·眉山到宋末）", dataset: sumai as GenealogyDataset },
  { key: "liuci", label: "东光刘氏·刘摰支（元祐党人·刘跂·997-1104）", dataset: liuci as GenealogyDataset },
  { key: "liukezi", label: "莆田刘氏·刘克庄支（后村先生·宋末词人·1187-1269）", dataset: liukezi as GenealogyDataset },
  { key: "wangshipeng", label: "乐清王氏·王十朋支（梅溪先生·南宋·1112-1171）", dataset: wangshipeng as GenealogyDataset },
  { key: "chenjun", label: "福清陈氏·陈俊卿支（南宋宰相·含陈圭·1113-1186）", dataset: chenjun as GenealogyDataset },
  { key: "zhaokui", label: "衡山赵氏·赵葵支（南宋将帅·赵淇·1186-1266）", dataset: zhaokui as GenealogyDataset },
  { key: "youmao", label: "梁溪尤氏·尤袤支（南宋四大诗人·1127-1194）", dataset: youmao as GenealogyDataset },
  { key: "zhangshi2", label: "留侯张氏·张纮支（东汉谋臣→宋代·153-1180）", dataset: zhangshi2 as GenealogyDataset },
  { key: "chenineng", label: "眉山陈氏·陈希亮支（陈慥父·陈与义·1000-1138）", dataset: chenineng as GenealogyDataset },
  { key: "jinlv", label: "金华金氏·金履祥支（朱子三传·宋末元初·1232-1303）", dataset: jinlv as GenealogyDataset },
  // CBDB 第四批：宋代名臣/元代文人/明清文人 + 欧阳修
  { key: "shihao", label: "明州史氏·史浩支（史弥远先祖·南宋宰相·1106-1194）", dataset: shihao as GenealogyDataset },
  { key: "zhouzhi", label: "庐陵周氏·周必大支（南宋宰相文学·1126-1204）", dataset: zhouzhi as GenealogyDataset },
  { key: "liuguan", label: "括苍柳氏·柳贯支（柳宗元裔·元代文学·1270-1342）", dataset: liuguan as GenealogyDataset },
  { key: "yuanjie", label: "河南元氏·元结支（唐代散文家·元稹祖系·719-772）", dataset: yuanjie as GenealogyDataset },
  { key: "shenshixing", label: "苏州申氏·申时行支（万历宰相·1535-1614）", dataset: shenshixing as GenealogyDataset },
  { key: "yuanhongdao", label: "公安袁氏·袁宏道支（公安三袁·1568-1610）", dataset: yuanhongdao as GenealogyDataset },
  { key: "biyuan", label: "苏州毕氏·毕沅支（《续资治通鉴》·1730-1797）", dataset: biyuan as GenealogyDataset },
  { key: "sunxingyan", label: "苏州孙氏·孙星衍支（含王采薇·乾嘉经学·1753-1818）", dataset: sunxingyan as GenealogyDataset },
  { key: "hongliang", label: "阳湖洪氏·洪亮吉支（乾嘉学派·人口论·1746-1809）", dataset: hongliang as GenealogyDataset },
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
