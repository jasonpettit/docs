var fs = require('fs');
var metalsmith = require('../scripts/metalsmith');
var Crawler = require('simplecrawler');
var cheerio = require('cheerio');
var url = require('url');
var util = require('util');
var chalk = require('chalk');
var _ = require('lodash');

var devices = ['photon', 'electron', 'core', 'raspberry-pi'];
var isPullRequest = process.env.TRAVIS_PULL_REQUEST && process.env.TRAVIS_PULL_REQUEST !== 'false';

function classifyUrl(item) {
  var info = {
    external: item.host !== 'localhost',
    image: item.path.match(/\.[png|jpg|jpeg|bmp|gif]/i),
    githubEditLink: item.url.indexOf('https://github.com/spark/docs/tree/master/src/content') === 0,
    autogeneratedApiLink: item.host === 'localhost' && item.path.indexOf('/reference/api/') === 0
  };
  return info;
}

function shouldCrawl(qurl) {
  if (qurl.indexOf('#') === 0) {
    return false;
  }
  return true;
}

describe('Crawler', function() {
  before(function(done) {
    this.timeout(120000);
    console.log('Building...');
    server = metalsmith.test(done);
  });

  after(function(done) {
    this.timeout(60000);
    server.shutdown(function(err) {
      if (err) {
        return done(err);
      }
      console.log('Compressing...');
      metalsmith.compress(done);
    });
  });

  it('should complete without error', function(done) {
    this.timeout(500000);
    var errors = 0;
    var crawler = new Crawler('localhost', '/', 8081);
    crawler.maxConcurrency = 10;
    crawler.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.134 Safari/537.36';
    crawler.acceptCookies = false;
    crawler.timeout = 20000;
    crawler.filterByDomain = false;
    crawler.interval = 5;
    crawler.supportedMimeTypes = [/^text\//i];
    crawler.downloadUnsupported = false;

    crawler.addFetchCondition(function(parsedUrl) {
      return parsedUrl.protocol !== 'mailto';
    });
    crawler.addFetchCondition(function(parsedUrl) {
      return !(parsedUrl.host === 'localhost' && parsedUrl.port === 35729);
    });
    crawler.addFetchCondition(function(parsedUrl) {
      return (parsedUrl.host !== 'vimeo.com');
    });
    crawler.addFetchCondition(function(parsedUrl) {
      return (parsedUrl.host !== 'tools.usps.com');
    });
    crawler.addFetchCondition(function(parsedUrl) {
      return (parsedUrl.host !== 'www.microsoft.com');
    });
    crawler.addFetchCondition(function(parsedUrl) {
      // Broken webserver that returns 404 not found for regular pages
      return (parsedUrl.host !== 'www.emaxmodel.com');
    });
    crawler.addFetchCondition(function(parsedUrl) {
      return (parsedUrl.host !== '192.168.0.1');
    });

    crawler.addDownloadCondition(function(queueItem) {
      var uriis = classifyUrl(queueItem);
      return !uriis.external;
    });

    crawler.discoverResources = function(buf, queueItem) {
      var urlis = classifyUrl(queueItem);
      if (urlis.external || urlis.image) {
        return [];
      }

      var $ = cheerio.load(buf.toString(), {
        normalizeWhitespace: false,
        xmlMode: false,
        decodeEntities: true
      });

      var parsedUrl = url.parse(queueItem.url);
      // is this the redirector page? follow device tree from here
      // this might make the crawl take ALOT longer
      if ($('#device-redirector').length === 1) {
        // determine if fromUrl was device specific
        var selectDevice;
        var parsedFromUrl = url.parse(queueItem.referrer);
        var devicePath = _.intersection(parsedFromUrl.pathname.split('/'), devices);
        if (devicePath.length > 0) {
          selectDevice = devicePath[0];
        }

        $('ul.devices').find('a').each(function(index, a) {
          // if we come from a device-specific page, only choose that device link forward
          if (selectDevice && $(a).attr('id') !== (selectDevice + '-link')) {
            return;
          }

          var toQueueUrl = $(a).attr('href');

          // include hash used to access redirector
          var absolutePath = url.resolve(queueItem.url, toQueueUrl) + (parsedUrl.hash || '');
          // preserve original fromUrl and content
          // c.queue([{
          //   uri: absolutePath,
          //   callback: crawlCallback.bind(null, fromUrl, absolutePath, content)
          // }]);
          if (!queueItem.meta) {
            console.log(queueItem);
          }
          crawler.queueURL(absolutePath, queueItem, { content: queueItem.meta.content });
        });
        return [];
      }

      // make sure the hash used is valid on this page
      if (parsedUrl.hash) {
        if (isPullRequest && urlis.autogeneratedApiLink) {
          return [];
        }

        if ($(parsedUrl.hash).length === 0) {
          console.error(chalk.red(util.format('ERROR: 404 (missing hash) ON %s CONTENT %s LINKS TO %s', queueItem.referrer, queueItem.meta.content, queueItem.url)));
          errors++;
        }
        // only check the hash here
        // let the non-hash version crawl the rest of the tree
        return [];
      }

      $('a').each(function(index, a) {
        var toQueueUrl = $(a).attr('href');
        var linkContent = $(a).text();
        if (!toQueueUrl) return;

        if (toQueueUrl.indexOf('#') === 0 && toQueueUrl.length > 1) {
          if (isPullRequest && urlis.autogeneratedApiLink) {
            return;
          }

          if ($(toQueueUrl).length === 0) {
            console.error(chalk.red(util.format('ERROR: 404 relative link ON %s CONTENT %s LINKS TO %s', queueItem.url, linkContent, toQueueUrl)));
            errors++;
          }
        }

        if (!shouldCrawl(toQueueUrl)) {
          return;
        }
        var absolutePath = url.resolve(queueItem.url, toQueueUrl);
        // Remove hash
        absolutePath = absolutePath.replace(/#.*/, '');
        crawler.queueURL(absolutePath, queueItem, { content: linkContent });
      });

      $('img').each(function (index, img) {
        var toQueueUrl = $(img).attr('src');
        if (!toQueueUrl) return;

        toQueueUrl = url.resolve(queueItem.url, toQueueUrl);
        crawler.queueURL(toQueueUrl, queueItem, { content: 'image' });
      });

      return [];
    };

    // crawler.on('fetchstart', function(queueItem) {
    //   console.log('start', queueItem.url);
    // });

    // crawler.on('fetchheaders', function(queueItem, response) {
    //   console.log('headers', queueItem.url, complete, len);
    // });

    // crawler.on('fetchcomplete', function(queueItem) {
    //   console.log('complete', queueItem.url);
    // });

    crawler.on('fetchtimeout', function (queueItem) {
      var msg = util.format('timeout ON %s CONTENT %s LINKS TO %s', queueItem.referrer, queueItem.meta.content, queueItem.url);
      var urlis = classifyUrl(queueItem);
      if (urlis.external) {
        console.log(chalk.yellow('WARN: ' + msg));
      } else {
        console.error(chalk.red('ERROR: ' + msg));
        errors++;
      }
    });

    function fetchResultError(queueItem, response) {
      if (queueItem.stateData.code === 429) {
        return;
      }
      if (queueItem.stateData.code === 200) {
        return;
      }

      var urlis = classifyUrl(queueItem);
      if ((isPullRequest && urlis.githubEditLink && queueItem.stateData.code === 404) ||
          (isPullRequest && urlis.autogeneratedApiLink && queueItem.stateData.code === 404)) {
        return;
      }

      var msg = util.format('%s ON %s CONTENT %s LINKS TO %s', queueItem.stateData.code, queueItem.referrer, queueItem.meta.content, queueItem.url);
      if (urlis.external && Math.floor(queueItem.stateData.code / 100) === 5) {
        // allow 5XX status codes on external links
        console.log(chalk.yellow('WARN: ' + msg));
        return;
      }
      console.error(chalk.red('ERROR: ' + msg));
      errors++;
    }

    crawler.on('fetch404', fetchResultError);
    crawler.on('fetcherror', fetchResultError);
    crawler.on('complete', function() {
      if (errors > 0) {
        return done(new Error('There are ' + errors + ' broken link(s)'));
      }
      return done();
    });
    crawler.start();
  });

});

