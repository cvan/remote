const http = require('http');
const path = require('path');
const url = require('url');

const dotenv = require('dotenv');
dotenv.config({path: path.join(__dirname, '..')});
dotenv.load();

const bodyParser = require('body-parser');
const ecstatic = require('ecstatic');
const express = require('express');
const expressPouchDB = require('express-pouchdb');
const fs = require('fs-extra');
const internalIp = require('internal-ip');
const passwordless = require('passwordless');
const pouchdb = require('pouchdb');
const PouchStore = require('passwordless-pouchstore');
const resisdown = require('redisdown');
const session = require('express-session');
const SocketPeer = require('socketpeer');
const trailingSlash = require('trailing-slash');
const twilio = require('twilio');

const PouchBase = require('./pouchbase.js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST,PUT',
  'Access-Control-Allow-Headers': 'Access-Control-Allow-Headers, Access-Control-Request-Method, Access-Control-Request-Headers, Origin, Accept, Authorization, X-Requested-With, Content-Type',
  'Access-Control-Expose-Headers': 'Location'
};

const dataDirName = 'data';
const dataDir = path.join(__dirname, '..', dataDirName);
const host = process.env.SOCKETPEER_HOST || process.env.HOST || '0.0.0.0';
const port = parseFloat(process.env.SOCKETPEER_PORT || process.env.PORT || '3000');
const nodeEnv = process.env.NODE_ENV || 'development';

const serverIp = internalIp.v4.sync();
const serverOrigin = nodeEnv === 'production' ? 'https://remote.webvr.rocks' : `http://${serverIp}:${port}`;

const app = express();

fs.ensureDirSync(dataDir);
fs.ensureDirSync(path.join(dataDir, 'core'));
fs.ensureDirSync(path.join(dataDir, 'tmp'));

const PouchDB = pouchdb.defaults({db: resisdown, url: process.env.REDIS_URL, prefix: `./${dataDirName}/core/`});

const TmpPouchDB = PouchDB.defaults({db: resisdown, url: process.env.REDIS_URL, prefix: `./${dataDirName}/tmp/`});
const PublicPouchDB = PouchDB.defaults({db: resisdown, url: process.env.REDIS_URL, prefix: `./${dataDirName}/public/`});

const pb = new PouchBase(serverOrigin + '/', PouchDB);

const httpServer = http.createServer(app);
const ecstaticMiddleware = ecstatic({
  root: path.join(__dirname, '..', 'client'),
  headers: corsHeaders,
  showdir: false
});
const peer = new SocketPeer({
  httpServer: httpServer,
  serveLibrary: true,
  headers: corsHeaders
});
const staticPaths = [
  '/',
  '/arrow.svg',
  '/box.svg',
  '/client.js',
  '/tachyons.min.css'
];

let pins = {};

function generatePinCode (length, unique) {
  if (typeof length === 'undefined') {
    length = 4;
  }

  if (typeof unique === 'undefined') {
    unique = true;
  }

  let pinDigits = [];
  for (let idx = 0; idx < length; idx++) {
    pinDigits.push(Math.floor(Math.random() * 10));
  }

  const pin = pinDigits.join('');

  if (unique && pin in pins) {
    return generatePinCode();
  }

  if (typeof pins[pin] !== 'number') {
    pins[pin] = 1;
  } else {
    pins[pin]++;
  }
  return pin;
}

function redirect (req, res, locationUrl) {
  const corsHandled = cors(req, res);
  if (!corsHandled) {
    return;
  }

  res.writeHead(302, {
    'Location': locationUrl,
    'Content-Length': '0'
  });
  res.end();
  return res;
}

function jsonBody (req, res, data, statusCode, contentType) {
  const corsHandled = cors(req, res);
  if (!corsHandled) {
    return;
  }

  res.writeHead(statusCode || 200, {
    'Content-Type': contentType || 'application/json'
  });
  res.end(JSON.stringify(data || {success: true}));
  return res;
}

function notFound (req, res, msg, contentType) {
  const corsHandled = cors(req, res);
  if (!corsHandled) {
    return;
  }

  res.writeHead(404, {
    'Content-Type': contentType || 'text/plain'
  });
  res.end(msg || 'File not found');
  return res;
}

/**
 * Parse phone numbers as strings to format accepted by Twilio.
 *
 * Examples:
 *
 *   +1 (650) 555-1212  =>  +16505551212
 *   6505551212         =>  6505551212
 *   650 555 1212       =>  6505551212
 *   650.555.1212       =>  6505551212
 *
 */
function parsePhoneNumber (str) {
  return str.replace(/[^0-9\+]/g, '');
}

function cors (req, res) {
  Object.keys(corsHeaders).forEach(header => {
    res.setHeader(header, corsHeaders[header]);
  });
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return false;
  }
  return true;
}

function jsonOrUrlencodedParser (req) {
  const contentType = req.headers['content-type'] || '';
  const parser = contentType.includes('json') ? bodyParser.json() : bodyParser.urlencoded({extended: false});
  return parser;
}

function sms (req, res) {
  const parser = jsonOrUrlencodedParser(req);

  // Values taken from the Twilio dashboard:
  //
  //   https://www.twilio.com/console
  //
  // Locally, these values are stored in the `.env` in the root directory,
  // which is not checked in to the Git repository (so ask @cvan for the details).
  //
  // In production (Heroku), values are stored as environment values:
  //
  //   https://dashboard.heroku.com/apps/webxr-remote/settings#ember1901
  //
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
    let twilioErr;
    if (!twilioAccountSid) {
      twilioErr = new Error('Expected environment variable `TWILIO_ACCOUNT_SID` to be set (ask @cvan)');
    }
    if (!twilioAuthToken) {
      twilioErr = new Error('Expected environment variable `TWILIO_AUTH_TOKEN` to be set (ask @cvan)');
    }
    if (!twilioPhoneNumber) {
      twilioErr = new Error('Expected environment variable `TWILIO_PHONE_NUMBER` to be set (ask @cvan)');
    }
    console.warn(twilioErr);
    jsonBody(req, res, {error: {message: twilioErr.message || 'Unknown error'}}, 400);
    return;
  }

  const twilioClient = new twilio(twilioAccountSid, twilioAuthToken);

  return Promise.resolve(parser(req, res, next));

  function next () {
    const smsBody = req.body.body;
    let smsTo = req.body.to;
    return new Promise((resolve, reject) => {
      if (!smsBody) {
        throw new Error('Value missing for `body` field (e.g., `Check this out!`)');
      }
      if (!smsTo) {
        throw new Error('Value missing for `to` field (e.g., `+16505551212`)');
      }
      smsTo = parsePhoneNumber(smsTo);
      if (!smsTo) {
        throw new Error('Unexpected value for `to` field (e.g., `+16505551212`)');
      }
      return twilioClient.messages.create({
        body: smsBody,
        to: smsTo,
        from: twilioPhoneNumber
      }, function (err, msg) {
        if (err) {
          return reject(err);
        }
        resolve(msg);
      });
    }).then(msg => {
      jsonBody(req, res, {success: true, sid: msg.sid}, 200);
    }).catch(err => {
      console.warn(err);
      jsonBody(req, res, {error: {message: err.message || 'Unknown error'}}, 400);
    });
  }
}

// const redisdownPouchDB = PouchDB.defaults({db: resisdown, url: process.env.REDIS_URL});

// const POUCHDB_DB_NAME = 'passwordless-tokens';
//
// passwordless.init(new PouchStore(POUCHDB_DB_NAME, {
//   db: resisdown,
//   url: process.env.REDIS_URL
// }));
//
// passwordless.addDelivery((tokenToSend, uidToSend, recipient, callback, req) => {
//   // Send out a token.
//   const msg = {
//     text: `Hello, sign in here: ${host}?token=${tokenToSend}&uid=${encodeURIComponent(uidToSend)}`,
//     from: 'webmaster@play.webvr.rocks',
//     to: recipient,
//     subject: `Token for ${host}`
//   };
//
//   req.body.to = recipient;
//   req.body.body = msg.text;
//
//   console.log('Sending token via SMS');
//
//   sms(req, res).then(success => {
//     console.log('Successfully sent SMS');
//   }).catch(err => {
//     console.error('Could not send SMS:', err);
//   });
// });

// app.use('/db/', expressPouchDB(redisdownPouchDB));

app.use((req, res, next) => {
  if (req.path.startsWith('/socketpeer/')) {
    return;
  }

  const pathnameClean = req.path.replace(/\/+$/g, '/').replace(/\/$/, '') || '/';

  if (pathnameClean === '/') {
    return redirect(req, res, '/' + generatePinCode());
  }

  if (req.path !== pathnameClean) {
    return redirect(req, res, pathnameClean);
  }

  trailingSlash({slash: false})(req, res, function () {
    session({
      secret: 'keyboard cat',
      maxAge: 1000 * 60 * 60 * 24 * 30
    })(req, res, next);
  });
});

app.all('*/index.html$', (req, res) => {
  const parsedUrl = url.parse(req.originalUrl);

  parsedUrl.pathname = req.path.replace(/\/index.html$/, '') || '/';

  const redirectUrl = url.format(parsedUrl);

  redirect(req, res, redirectUrl);
});

app.post('/sms', (req, res) => {
  sms(req, res);
});


// app.get('/', (req, res) => { res.render('testserver'); });
app.get('/tmp/', (req, res) => { res.render('testserver'); });
app.get('/public/', (req, res) => { res.render('datasets'); });
app.get('/user/', (req, res) => { res.render('userdb'); });

// Temporary database requires no authentication, so forward the user directly.
app.use('/db/tmp/', expressPouchDB(TmpPouchDB));

// Public databases will allow users to read but not write data.
function unauthorized (req, res, next) {
  res.status(401).send({
    error: true,
    message: 'Unauthorized'
  });
  next();
}

app.post('/db/public/*', unauthorized);
app.delete('/db/public/*', unauthorized);
app.put('/db/public/*', unauthorized);
app.use('/db/public', expressPouchDB(PublicPouchDB));

// User databases require the user to be logged in
app.use('/db/users/', (req, res, next) => {
  if (!req.session.user) {
    console.warn('Unauthorized database access');
    return unauthorized(req, res, next);
  }

  const dbName = pb.usersDbName(req.session.user, req.headers.origin);
  req.url = '/' + dbName + '/' + req.url.substring(1);
  next();
});
app.use('/db/users', expressPouchDB(PouchDB));

app.all('/session/', function (req, res, next) {
  console.log('•••', req.path);
  if (!req.session.user) {
    console.warn('Unauthorized database access');
    return unauthorized(req, res, next);
  } else {
    next();
  }
});

app.get('/session/', function (req, res) {
  console.log('•••', req.path);
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    pb.readSession(req.session.user, req.headers.origin)
      .then(function (result) {
        res.send(result);
      });
  });
});

app.post('/session/', function (req, res) {
  console.log('•••', req.path);
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    pb.writeSession(req.session.user, req.headers.origin, req.body)
      .then(function (result) {
        res.send(result);
      });
  });
});

app.post('/login/', function (req, res) {
  console.log('•••', req.path);
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    console.log('req.body', req.body);
    pb.login(req.body, req.headers.origin).then(function (result) {
      res.send(result);
    });
  });
});

app.use(bodyParser.urlencoded({extended: false}));

app.all('/validate/', function (req, res) {
  console.log('•••', req.path);
  // const parser = jsonOrUrlencodedParser(req);
  // parser(req, res, () => {
    console.log(req.body, req.query);
    var uid = req.query.uid;
    var token = req.query.token;
    var host = req.query.host;
    pb.authenticate(uid, host, token).then(function (result) {
      if (result.ok) {
        req.session.user = req.query.uid;
      }
      if (req.method === 'GET' && result.origin) {
        res.redirect(result.origin);
      } else {
        res.send(result);
      }
    });
});

app.post('/logout/', function (req, res) {
  console.log('•••', req.path);
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    req.session = null;
    res.send({ok: true});
  });
});

// app.get('/session', (req, res, next) => {
//   const corsHandled = cors(req, res);
//   if (!corsHandled) {
//     return;
//   }
//
//   const parser = jsonOrUrlencodedParser(req);
//
//   parser(req, res, function () {
//     session({
//       keys: ['keyboard', 'cat'],
//       maxAge: 1000 * 60 * 60 * 24 * 30
//     })(req, res, function () {
//       passwordless.sessionSupport()(req, res, function () {
//         passwordless.acceptToken()(req, res, function () {
//           console.log(req.path);
//           res.json({
//             ok: true,
//             user: 'email@domain.com',
//             db: serverOrigin + '/db'
//           });
//         });
//       });
//     });
//   });
//
//   // app.use(passwordless.sessionSupport());
//   // app.use(passwordless.acceptToken());
// });

// app.post('/', passwordless.requestToken(function (user, delivery, callback) {
//         // lookup your user from supplied phone number
//         // `user` is the value from your html input (by default an input with name = 'user')
//         // for this example we're just return the supplied number
//         callback(null, user);
//     }),
//     function (req, res) {
//         res.render('verify', { uid: req.passwordless.uidToAuth });
//     }
// );

app.use((req, res, next) => {
  if (req.path.startsWith('/socketpeer/')) {
    return;
  }

  const pathnameHasPin = /^\/[0-9]+$/.test(req.path);
  if (pathnameHasPin) {
    req.url = '/';
    return ecstaticMiddleware(req, res, next);
  }

  if (staticPaths.includes(req.path)) {
    return ecstaticMiddleware(req, res, next);
  }

  notFound(req, res);
});

if (!module.parent) {
  app.listen(port, host, () => {
    console.log('[%s] Server running on %s', nodeEnv, serverOrigin);
  });
}

module.exports.app = app;

module.exports.httpServer = httpServer;

module.exports.peer = peer;
