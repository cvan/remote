const http = require('http');
const path = require('path');
const url = require('url');

const dotenv = require('dotenv');
dotenv.config({path: path.join(__dirname, '..')});
dotenv.load();

const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');  // TODO: Remove.
const ecstatic = require('ecstatic');
const express = require('express');
const expressPouchDB = require('express-pouchdb');
const expressSession = require('express-session');
const fs = require('fs-extra');
const internalIp = require('internal-ip');
const levelup = require('levelup');
const methodOverride = require('method-override');
const passwordless = require('passwordless');
const PouchDB = require('pouchdb');
const PouchStore = require('passwordless-pouchstore');
const resisdown = require('redisdown');
const SocketPeer = require('socketpeer');
const trailingSlash = require('trailing-slash');
const twilio = require('twilio');

// const PouchBase = require('./pouchbase.js');

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
const redisUrl = process.env.REDIS_URL || process.env.REDISCLOUD_URL;

const app = express();

app.set('host', host);
app.set('port', port);

const serverIp = internalIp.v4.sync();
const serverOrigin = nodeEnv === 'production' ? 'https://remote.webvr.rocks' : `http://${serverIp}:${app.get('port')}`;

// fs.ensureDirSync(dataDir);
// fs.ensureDirSync(path.join(dataDir, 'core'));
// fs.ensureDirSync(path.join(dataDir, 'tmp'));

// const PouchDB = pouchdb.defaults({db: resisdown, url: process.env.REDIS_URL, prefix: `./${dataDirName}/core/`});
//
// const TmpPouchDB = PouchDB.defaults({db: resisdown, url: process.env.REDIS_URL, prefix: `./${dataDirName}/tmp/`});
// const PublicPouchDB = PouchDB.defaults({db: resisdown, url: process.env.REDIS_URL, prefix: `./${dataDirName}/public/`});

// const pb = new PouchBase(serverOrigin + '/', PouchDB);

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

app.set('views', path.join(__dirname, 'templates'));
app.set('view engine', 'ejs');

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

const db = levelup('xr', {db: resisdown, url: redisUrl});
const redisdownPouchDB = PouchDB.defaults({
  db: db,
  prefix: `./${dataDirName}/`
});

app.use('/db/', expressPouchDB(PouchDB, {
  configPath: path.join(__dirname, 'config.json'),
  db: redisdownPouchDB
}));

const POUCHDB_DB_NAME = 'xr:passwordlessTokens';
passwordless.init(new PouchStore(POUCHDB_DB_NAME, {db: db}));
passwordless.addDelivery('sms', (tokenToSend, uidToSend, recipient, callback, req) => {
  // Send out a token.
  const msg = {
    text: `Hello, sign in here: ${serverOrigin}/api/login?token=${tokenToSend}&uid=${encodeURIComponent(uidToSend)}`,
    from: 'webmaster@play.webvr.rocks',
    to: recipient,
    subject: `Proceed to sign in to ${serverOrigin} …`
  };

  console.log('Sending message …', msg);

  req.body.to = recipient;
  req.body.body = msg.text;

  console.log('Sending token via SMS');

  sms(req, res).then(success => {
    console.log('Successfully sent SMS');
  }).catch(err => {
    console.error('Could not send SMS:', err);
  });
}, {
  ttl: 100 * 60 * 10
});

const api = express.Router();
api.use(methodOverride());
api.use(cookieParser(process.env.SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
api.use(expressSession({
  secret: process.env.SESSION_SECRET,
  maxAge: 1000 * 60 * 60 * 24 * 30,
  saveUninitialized: false,
  resave: false
}));
api.use(passwordless.sessionSupport());
api.use(passwordless.acceptToken({
  enableOriginRedirect: true,
  successRedirect: '/api/index'
}));
api.get('/index', (req, res) => {
  res.render('index', {title: 'Index'});
});
api.post('/sendtoken', passwordless.requestToken((user, delivery, callback, req) => {
  if (delivery === 'sms') {
    // Look up phone number.
  } else if (delivery === 'email') {
    // Look up email.
  }

  // User.find({email: user}, result => {
  //   if (result) {
  //     return callback(null, result.id);
  //   }
  //   callback(null, null);
  // });

  callback(null, user);
}), (req, res) => {
  // res.render('verify', {uid: req.passwordless.uidToAuth});
  res.send(`sent uid: ${req.passwordless.uidToAuth}`);
});
api.get('/login', (req, res) => {
  res.render('login', {title: 'Log in'});
});
api.post('/login', passwordless.requestToken((user, delivery, callback) => {
  console.log('/login request');
  // Identify user.

  // look up your user from the supplied phone number.
  // `user` is the value from your html input (by default an input with name = 'user')
  // for this example we're just return the supplied number
  callback(null, user);
}), {
  failureRedirect: '/login'
}, (req, res) => {
  // Success.
  console.log('/login verify');
  res.json({
    state: 'verify',
    uid: req.passwordless.uidToAuth
  });
});
api.post('/verify', passwordless.acceptToken({allowPost: true, successRedirect: '/api/users'}));
api.get('/users', passwordless.restricted({originField: 'to', failureRedirect: '/api/login?to=/api/users'}), (req, res) => {
  res.json({
    'name': 'users',
    'objects': []
  });
});
app.use('/api', api);

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

  trailingSlash({slash: false})(req, res, next);
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
// app.get('/tmp/', (req, res) => { res.render('testserver'); });
// app.get('/public/', (req, res) => { res.render('datasets'); });
// app.get('/user/', (req, res) => { res.render('userdb'); });

// Temporary database requires no authentication, so forward the user directly.
// app.use('/db/tmp/', expressPouchDB(TmpPouchDB));

// Public databases will allow users to read but not write data.
function unauthorized (req, res, next) {
  res.status(401).send({
    error: true,
    message: 'Unauthorized'
  });
  next();
}

// app.post('/db/public/*', unauthorized);
// app.delete('/db/public/*', unauthorized);
// app.put('/db/public/*', unauthorized);
// app.use('/db/public', expressPouchDB(PublicPouchDB));

// User databases require the user to be logged in
// app.use('/db/users/', (req, res, next) => {
//   if (!req.session.user) {
//     console.warn('Unauthorized database access');
//     return unauthorized(req, res, next);
//   }
//
//   const dbName = pb.usersDbName(req.session.user, req.headers.origin);
//   req.url = '/' + dbName + '/' + req.url.substring(1);
//   next();
// });
// app.use('/db/users', expressPouchDB(PouchDB));

// app.all('/session/', function (req, res, next) {
//   console.log('•••', req.path);
//   if (!req.session.user) {
//     console.warn('Unauthorized database access');
//     return unauthorized(req, res, next);
//   } else {
//     next();
//   }
// });

/*
app.get('/session/', function (req, res) {
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    pb.readSession(req.session.user, req.headers.origin)
      .then(function (result) {
        res.send(result);
      });
  });
});

app.post('/session/', function (req, res) {
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    pb.writeSession(req.session.user, req.headers.origin, req.body)
      .then(function (result) {
        res.send(result);
      });
  });
});

app.post('/login/', function (req, res) {
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    console.log('req.body', req.body);
    pb.login(req.body, req.headers.origin).then(function (result) {
      res.send(result);
    });
  });
});

app.all('/validate/', function (req, res) {
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
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
});

app.post('/logout/', function (req, res) {
  const parser = jsonOrUrlencodedParser(req);
  parser(req, res, () => {
    req.session = null;
    res.send({ok: true});
  });
});
*/

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
  app.listen(app.get('port'), app.get('host'), () => {
    console.log('[%s] Server running on %s', nodeEnv, serverOrigin);
  });
}

module.exports.app = app;

module.exports.httpServer = httpServer;

module.exports.peer = peer;
