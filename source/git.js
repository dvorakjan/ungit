var child_process = require('child_process');
var gitParser = require('./git-parser');
var async = require('async');
var path = require('path');
var fs = require('fs');
var config = require('./config');
var winston = require('winston');
var inherits = require('util').inherits;
var addressParser = require('./address-parser');
var GitTask = require('./git-task');
var _ = require('lodash');
var isWindows = /^win/.test(process.platform);
var Promise = require('bluebird');

var gitConfigArguments = ['-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.pager=cat'];

var git = function(commands, repoPath, allowedCodes, outPipe, user) {
  commands = gitConfigArguments.concat(commands).filter(function(element) {
    return element;
  });

  return new GitExecutionTask(commands, repoPath, allowedCodes, outPipe, user);
}

var GitExecutionTask = function(commands, repoPath, allowedCodes, outPipe, user) {
  GitTask.call(this);
  var self = this;
  this.repoPath = repoPath;
  this.commands = commands;
  this.user     = user;
  this._timeout = 2*60*1000; // Default timeout tasks after 2 min
  this.potentialError = new Error(); // caputers the stack trace here so that we can use it if the command fail later on
  this.potentialError.commmands = commands;
  this.allowedCodes = allowedCodes;
  this.outPipe = outPipe;
  this.start = function() {
    git.queueTask(self);
  }
}
inherits(GitExecutionTask, GitTask);
GitExecutionTask.prototype.parser = function(parser, parseArgs) {
  this._parser = parser;
  this.parseArgs = parseArgs;
  return this;
}
GitExecutionTask.prototype.timeout = function(timeout) {
  this._timeout = timeout;
  return this;
}


git.runningTasks = [];

var gitQueue = async.queue(function (task, callback) {

  // test string user when basic auth or object in case of ldap
  var sudoUser = '';
  if (typeof task.user == 'string') {
    sudoUser = task.user;
  }
  if (typeof task.user == 'object' && typeof task.user.uid == 'string') {
    sudoUser = task.user.uid;
  }

  var command = 'git';
  if (sudoUser.length > 0) {
    task.commands.unshift('git');
    if (config.umask) {
      task.commands = ['bash', '-c', 'umask ' + config.umask + ' && ' + task.commands.join(' ')];
    }

    if (typeof config.sudoGroup == 'string' && config.sudoGroup.length > 0) {
      task.commands.unshift(config.sudoGroup);
      task.commands.unshift('-g');
    }
    task.commands.unshift(sudoUser);
    task.commands.unshift('-u');
    command = 'sudo';
  }

  if (config.logGitCommands) winston.info('git executing: ' + task.repoPath + ' ' + command + ' ' + task.commands.join(' '));
  git.runningTasks.push(task);
  task.startTime = Date.now();


  var gitProcess = child_process.spawn(
      command,
    task.commands,
    {
      cwd: task.repoPath,
      maxBuffer: 1024 * 1024 * 100,
      timeout: task._timeout
    });
  task.process = gitProcess;
  task.setStarted();
  var allowedCodes = task.allowedCodes || [0];

  var stdout = '';
  var stderr = '';

  if (task.outPipe) {
    gitProcess.stdout.pipe(task.outPipe);
  } else {
    gitProcess.stdout.on('data', function(data) {
      stdout += data.toString();
    });
  }
  gitProcess.stderr.on('data', function(data) {
    stderr += data.toString();
  });
  gitProcess.on('error', function (error) {
    if (task.outPipe) task.outPipe.end();
    callback(error);
  });

  gitProcess.on('close', function (code) {
    if (config.logGitCommands) winston.info('git result (first 400 bytes): ' + task.commands.join(' ') + '\n' + stderr.slice(0, 400) + '\n' + stdout.slice(0, 400));
    if (task.outPipe) task.outPipe.end();

    if (allowedCodes.indexOf(code) < 0) {
      var err = {};
      err.isGitError = true;
      err.errorCode = 'unknown';
      err.stackAtCall = task.potentialError.stack;
      err.lineAtCall = task.potentialError.lineNumber;
      err.command = task.commands.join(' ');
      err.workingDirectory = task.repoPath;
      err.error = stderr.toString();
      err.message = err.error.split('\n')[0];
      err.stderr = stderr;
      err.stdout = stdout;
      if (stderr.indexOf('Not a git repository') >= 0)
        err.errorCode = 'not-a-repository';
      else if (err.stderr.indexOf('Connection timed out') != -1)
        err.errorCode = 'remote-timeout';
      else if (err.stderr.indexOf('Permission denied (publickey)') != -1)
        err.errorCode = 'permision-denied-publickey';
      else if (err.stderr.indexOf('ssh: connect to host') != -1 && err.stderr.indexOf('Bad file number') != -1)
        err.errorCode = 'ssh-bad-file-number';
      else if (err.stderr.indexOf('No remote configured to list refs from.') != -1)
        err.errorCode = 'no-remote-configured';
      else if ((err.stderr.indexOf('unable to access') != -1 && err.stderr.indexOf('Could not resolve host:') != -1) ||
        (err.stderr.indexOf('Could not resolve hostname') != -1))
        err.errorCode = 'offline';
      else if (err.stderr.indexOf('Proxy Authentication Required') != -1)
        err.errorCode = 'proxy-authentication-required';
      else if (err.stderr.indexOf('Please tell me who you are') != -1)
        err.errorCode = 'no-git-name-email-configured';
      else if (err.stderr.indexOf('FATAL ERROR: Disconnected: No supported authentication methods available (server sent: publickey)') == 0)
        err.errorCode = 'no-supported-authentication-provided';
      else if (stderr.indexOf('fatal: No remote repository specified.') == 0)
        err.errorCode = 'no-remote-specified';
      else if (err.stderr.indexOf('non-fast-forward') != -1)
        err.errorCode = 'non-fast-forward';
      else if (err.stderr.indexOf('Failed to merge in the changes.') == 0 || err.stdout.indexOf('CONFLICT (content): Merge conflict in') != -1 || err.stderr.indexOf('after resolving the conflicts') != -1)
        err.errorCode = 'merge-failed';
      else if (err.stderr.indexOf('This operation must be run in a work tree') != -1)
        err.errorCode = 'must-be-in-working-tree';
      else if (err.stderr.indexOf('Your local changes to the following files would be overwritten by checkout') != -1)
        err.errorCode = 'local-changes-would-be-overwritten';

      task.setResult(err);
      callback(err);
    } else {
      task.setResult(null, task._parser ? task._parser(stdout, task.parseArgs) : stdout);
      callback();
    }
    git.runningTasks.splice(git.runningTasks.indexOf(task), 1);
  });
}, config.maxConcurrentGitOperations);

git.queueTask = function(task) {
  gitQueue.push(task);
}

git.status = function(repoPath, file, user) {
  var task = new GitTask();

  task.start = function() {
    async.parallel([
      function(done) {
        git(['status', '-s', '-b', '-u', (file || '')], repoPath, undefined, undefined, user)
          .parser(gitParser.parseGitStatus)
          .fail(done)
          .done(function(status) {
            // From http://stackoverflow.com/questions/3921409/how-to-know-if-there-is-a-git-rebase-in-progress
            status.inRebase = fs.existsSync(path.join(repoPath, '.git', 'rebase-merge')) ||
              fs.existsSync(path.join(repoPath, '.git', 'rebase-apply'));

            status.inMerge = fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD'));

            if (status.inMerge) {
              status.commitMessage = fs.readFileSync(path.join(repoPath, '.git', 'MERGE_MSG'), { encoding: 'utf8' });
            }

            done(null, status);
          }).start();
      },
      function(done) {
        // stats for staged files
        git(['diff', '--numstat', '--cached', '--', (file || '')], repoPath, undefined, undefined, user)
          .parser(gitParser.parseGitStatusNumstat)
          .always(function(err, numstats) {
            done(null, numstats || {});
          }).start();
      },
      function(done) {
        // stats for unstaged files
        git(['diff', '--numstat', '--', (file || '')], repoPath, undefined, undefined, user)
          .parser(gitParser.parseGitStatusNumstat)
          .always(function(err, numstats) {
            done(null, numstats || {});
          }).start();
      }
    ], function(err, results) {
      if (err) {
        task.setResult(err);
        return;
      }

      var status = results[0];
      var numstats = results.slice(1).reduce(_.extend, {});

      // merge numstats
      Object.keys(status.files).forEach(function(filename) {
        // git diff returns paths relative to git repo but git status does not
        var absoluteFilename = filename.replace(/\.\.\//g, '');
        var stats = numstats[absoluteFilename] || { additions: '-', deletions: '-' };
        status.files[filename].additions = stats.additions;
        status.files[filename].deletions = stats.deletions;
      });

      task.setResult(null, status);
    });
  };

  return task;
}

git.getRemoteAddress = function(repoPath, remoteName, user) {
  return git(['config', '--get', 'remote.' + remoteName + '.url'], repoPath, undefined, undefined, user)
    .parser(function(text) {
      return addressParser.parseAddress(text.split('\n')[0]);
    });
}

git.stashAndPop = function(repoPath, wrappedTask, user) {
  var task = new GitTask();

  var gitTask = git(['stash'], repoPath, undefined, undefined, user)
    .always(function(err, res) {
      var hadLocalChanges = true;
      if (err) {
        if (err.stderr.indexOf('You do not have the initial commit yet') != -1) {
          hadLocalChanges = false;
        } else {
          task.setResult(err, res);
          return;
        }
      } else {
        if (res.indexOf('No local changes to save') != -1)
          hadLocalChanges = false;
      }
      if (hadLocalChanges) {
        var popTask = git(['stash', 'pop'], repoPath, undefined, undefined, user).always(task.setResult);
        wrappedTask.always(function() { popTask.start(); });
      } else {
        wrappedTask.always(task.setResult);
      }
      wrappedTask.start();
    });
  task.started(gitTask.start);
  return task;
}

git.binaryFileContent = function(repoPath, filename, version, outPipe, user) {
  return git(['show', version + ':' + filename], repoPath, null, outPipe, user);
}

git.diffFile = function(repoPath, filename, sha1, user) {
  var task = new GitTask();

  var statusTask = git.status(repoPath)
    .fail(task.setResult)
    .done(function(status) {
      var file = status.files[filename];
      var filePath = path.join(repoPath, filename);
      if (!file && !sha1) {
        if (fs.existsSync(path.join(repoPath, filename))) task.setResult(null, []);
        else task.setResult({ error: 'No such file: ' + filename, errorCode: 'no-such-file' });
        // If the file is new or if it's a directory, i.e. a submodule
      } else {
        var gitCommands;
        var allowedCodes = null;  // default is [0]
        var gitNewFileCompare = ['diff', '--no-index', isWindows ? 'NUL' : '/dev/null', filename.trim()];

        if (file && file.isNew) {
          gitCommands = gitNewFileCompare;
          allowedCodes =  [0, 1];
        } else if (sha1) {
          gitCommands = ['diff', sha1 + "^", sha1, "--", filename.trim()];
        } else {
          gitCommands = ['diff', 'HEAD', '--', filename.trim()];
        }

        git(gitCommands, repoPath, allowedCodes, undefined, user).always(function(err, result) {
          // when <rev> is very first commit and 'diff <rev>~1:[file] <rev>:[file]' is performed,
          // it will error out with invalid object name error
          if (sha1 && err && err.error.indexOf('bad revision') > -1) {
            git(gitNewFileCompare, repoPath, [0, 1], undefined, user).always(task.setResult).start();
          } else {
            task.setResult(err, result);
          }
        }).start();
      }
    });

  task.started(statusTask.start);

  return task;
}

git.discardAllChanges = function(repoPath, user) {
  var task = new GitTask();

  var gitTask = git(['reset', '--hard', 'HEAD'], repoPath, undefined, undefined, user)
    .fail(task.setResult)
    .done(function() {
      git(['clean', '-fd'], repoPath, undefined, undefined, user).always(task.setResult).start();
    });
  task.started(gitTask.start);

  return task;
}

git.discardChangesInFile = function(repoPath, filename, user) {
  var task = new GitTask();

  var filePath = path.join(repoPath, filename);

  var statusTask = git.status(repoPath, filename)
    .fail(task.setResult)
    .done(function(status) {
      if (Object.keys(status.files).length == 0) throw new Error('No files in status in discard, filename: ' + filename);
      var fileStatus = status.files[Object.keys(status.files)[0]];

      if (!fileStatus.staged) {
        // If it's just a new file, remove it
        if (fileStatus.isNew) {
          fs.unlink(filePath, function(err) {
            if (err) task.setResult({ command: 'unlink', error: err });
            else task.setResult();
          });
        // If it's a changed file, reset the changes
        } else {
          git(['checkout', 'HEAD', '--', filename.trim()], repoPath, undefined, undefined, user)
            .always(task.setResult)
            .start();
        }
      } else {
        git(['rm', '-f', filename], repoPath, undefined, undefined, user).always(task.setResult).start();
      }
    });
  task.started(statusTask.start);

  return task;
}

var parseDiffForPatch = function (patch, repoPath, user) {
  return new Promise(function (resolve, reject) {
    git(['diff', patch.name], repoPath, undefined, undefined, user)
      .fail(reject)
      .done(resolve).start();
  });
}

var applyPatchedDiff = function(patch, repoPath, patchedDiff, user) {
  return new Promise(function (resolve, reject) {
    if (patchedDiff) {
      git(['apply', '--cached'], repoPath, undefined, undefined, user)
        .fail(reject)
        .done(resolve)
        .started(function() {
          this.process.stdin.end(patchedDiff + '\n\n');
        }).start();
    } else {
      resolve();
    }
  });
}

git.updateIndexFromFileList = function(repoPath, files, user) {
  var task = new GitTask();
  var statusTask;

  new Promise(function (resolve, reject) {
    statusTask = git.status(repoPath)
      .fail(reject)
      .done(resolve);
  }).then(function(status) {
    var toAdd = [];
    var toRemove = [];
    var toPatch = [];

    for(var v in files) {
      var file = files[v];
      var fileStatus = status.files[file.name] || status.files[path.relative(repoPath, file.name)];
      if (!fileStatus) {
        task.setResult({ error: 'No such file in staging: ' + file.name });
        return;
      }

      if (fileStatus.removed) toRemove.push(file.name);
      else if (files[v].patchLineList) toPatch.push(file)
      else toAdd.push(file.name);
    }

    var addPromise = new Promise(function (resolve, reject) {
      if (toAdd.length == 0) {
        resolve();
        return;
      }
      git(['update-index', '--add', '--stdin'], repoPath, undefined, undefined, user)
        .done(resolve)
        .fail(reject)
        .started(function() {
          var filesToAdd = toAdd.map(function(file) { return file.trim(); }).join('\n');
          this.process.stdin.end(filesToAdd);
        }).start();
    });

    var removePromise = new Promise(function (resolve, reject) {
      if (toRemove.length == 0) {
        resolve();
        return;
      }
      git(['update-index', '--remove', '--stdin'], repoPath, undefined, undefined, user)
        .done(resolve)
        .fail(reject)
        .started(function() {
          var filesToRemove = toRemove.map(function(file) { return file.trim(); }).join('\n');
          this.process.stdin.end(filesToRemove);
        }).start();
    });

    var patchPromise = new Promise(function (resolve, reject) {
      if (toPatch.length == 0) {
        resolve();
        return;
      }

      var diffPatchArray = [];
      // handle patchings per file bases
      for (var n = 0; n < toPatch.length; n++) {
        diffPatchArray.push(parseDiffForPatch(toPatch[n], repoPath, user)
          .then(gitParser.parsePatchDiffResult.bind(null, toPatch[n].patchLineList))
          .then(applyPatchedDiff.bind(null, toPatch[n], repoPath, undefined, user)));
      }

      Promise.all(diffPatchArray).then(resolve, reject);
    });

    return Promise.join(addPromise, removePromise, patchPromise);
  }).then(task.setResult.bind(null, null), task.setResult);

  task.started(statusTask.start);
  return task;
}

git.commit = function(repoPath, amend, message, files, user) {
  var task = new GitTask();

  if (message === undefined)
    return task.setResult({ error: 'Must specify commit message' });

  if ((!(Array.isArray(files)) || files.length == 0) && !amend)
    return task.setResult({ error: 'Must specify files or amend to commit' });

  var updateIndexTask = git.updateIndexFromFileList(repoPath, files, user)
    .fail(task.setResult)
    .done(function() {
      git(['commit', (amend ? '--amend' : ''), '--file=-'], repoPath, undefined, undefined, user)
        .always(function(err) {
          // ignore the case where nothing were added to be committed
          if (!err || err.stdout.indexOf("Changes not staged for commit") > -1) {
            task.setResult();
          } else {
            try {
              task.setResult(err);
            } catch (e) {
              // log if json result is already sent...  should be fixed with promise impl
              console.log(e);
            }
          }
        })
        .started(function() {
          this.process.stdin.end(message);
        })
        .start();
    });
  task.started(updateIndexTask.start);

  return task;
}

git.resolveConflicts = function(repoPath, files, user) {
  var task = new GitTask();

  task.start = function() {
    var toAdd = [], toRemove = [];
    async.map(files, function(file, callback) {
      fs.exists(path.join(repoPath, file), function(exists) {
        if (exists) toAdd.push(file);
        else toRemove.push(file);
        callback();
      })
    }, function() {

      async.parallel([
        function(done) {
          if (toAdd.length == 0) return done();
          git(['add', toAdd.map(function(file) { return file; })], repoPath, undefined, undefined, user)
            .always(done)
            .start();
        },
        function(done) {
          if (toRemove.length == 0) return done();
          git(['rm', toRemove.map(function(file) { return file; })], repoPath, undefined, undefined, user)
            .always(done)
            .start();
        },
      ], function(err) {
        task.setResult(err);
      });

    });
    task.setStarted();
  }

  return task;
}

git.getCurrentBranch = function(repoPath, user) {
  var task = new GitTask();
  var gitTask = git(['rev-parse', '--show-toplevel'], repoPath, undefined, undefined, user)
    .fail(task.setResult)
    .done(function(rootRepoPath) {

      var HEADFile = path.join(rootRepoPath.trim(), '.git', 'HEAD');
      if (!fs.existsSync(HEADFile))
        return task.setResult({ errorCode: 'not-a-repository', error: 'No such file: ' + HEADFile });
      fs.readFile(HEADFile, { encoding: 'utf8' }, function(err, text) {
        if (err) return task.setResult(err);
        text = text.toString();
        var rows = text.split('\n');
        var branch = rows[0].slice('ref: refs/heads/'.length);
        task.setResult(null, branch);
      });
    });
  task.started(gitTask.start);
  return task;
}

module.exports = git;
