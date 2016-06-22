/**
 * Created by yellow79 on 01.07.15.
 */
var net = require('net'),
    dns = require('dns'),
    common = require('./socket.common.js');

module.exports.client = function(namespace, config, options) {
    function Client(namespace, config, options) {
        var options = typeof options === 'number' ? {timeout: options} : options ? options : {};

        this.namespace = namespace;
        this.timeout = options.timeout || 100000;

        this.servers  = [];
        if (config.host && config.port) config = [config];
        if (config.length) {
            for (var i = 0; i < config.length; i++) {
                this.servers.push({host: config[i].host, port: config[i].port, reconnects: 0});
            }
        }

        this._logger = options.logger === undefined ? console : options.logger;
        if (!this._logger) {
            this._logger = {};
        }

        if (!this._logger.error) {
            this._logger.error = function() {};
        }

        this._reconnectExp = options.reconnectExp || 10;
        var maxSleep = options.reconnectMaxSleep || 10000;
        this._reconnectBase = Math.pow(maxSleep, 1 / this._reconnectExp);

        this.sockets = [];
        this.curSock = 0;
        this.reqno = 1;
        this.queue = {};
        this._state = 0;
    }

    Client.prototype.connect = function(callback) {
        var self = this;

        var real_connect = function(index) {
            self._state = 1;
            var socket = new net.Socket();
            var queue = self.queue;

            var errback = function(err) {
                socket.removeListener('error', errback);
                setTimeout(real_connect.bind(self), 10, index);
            };
            socket.on('error', errback);

            socket.on('connect', function() {
                self._state = 2;
                socket.setNoDelay(true);
                self.servers[index].reconnects = 0

                socket.removeListener('error', errback);
                socket.on('error', function(err) {
                    for (var i in queue) {
                        setImmediate(queue[i].fn, err, null);
                        delete queue[i];
                    }
                });

                common.AddLineReader(socket);
                socket.on('line', function(data) {
                    var json = safeExecute(JSON.parse, data, []);
                    if (json[0] && queue[json[0]]) {
                        queue[json[0]].fn(json[1], json[2]);
                        delete queue[json[0]];
                    }
                });

                if (self.sockets[index]) self.sockets[index].destroy();
                self.sockets[index] = socket;
                self.servers[index].connect = true;

                isConnect();
            });

            socket.on('close', function() {
                if (self._state === 2) {
                    self._logger.error('Server', self.servers[index].host + ':' + self.servers[index].port, 'disconnected! Trying to automatically to reconnect');
                    for (var i in queue) {
                        setImmediate(queue[i].fn, new Error('Server disconnected'), null);
                        delete queue[i];
                    }

                    var r = self.servers[index].reconnects;
                    var sleep = r < self._reconnectExp - 1 ? Math.floor(Math.pow(self._reconnectBase, r + 2)) : 10000;
                    setTimeout(real_connect.bind(self), sleep, index);
                }
                self._state = 0;
            });

            socket.connect({port: self.servers[index].port, host: self.servers[index].host});

        }.bind(self);

        var errs = [];
        self.servers.forEach(function(server, i) {
            if (!net.isIP(server.host)) {
                dns.resolve(server.host, function(err, ips) {
                    if (!err) {
                        server.host = ips[0];
                        real_connect(i);
                    } else {
                        errs.push(err);
                        server.resolve = true;
                    }

                    if (self.servers.length == i+1 && errs.length == self.servers.length) {
                        callback(errs);
                    }
                }.bind(server));
            } else {
                real_connect(i);
                if (self.servers.length == i+1 && errs.length == self.servers.length) {
                    callback(errs);
                }
            }
        });

        var connectCount = 0;
        function isConnect() {
            connectCount++;
            if (connectCount == 1) callback(errs.length ? errs : null);
        }
    };

    Client.prototype.disconnect = function(callback) {
        this._state = 0;
        for (var i = 0; i < this.sockets.length; i++) {
            this.sockets[i].end();
        }
    };

    Client.prototype.ping = function(callback) {
        this.send('ping', [], callback);
    };

    Client.prototype.send = function(method, args, callback, delay) {
        if (!this.sockets.length) {
            return setImmediate(this.send.bind(this), method, args, callback);
        }

        var data;
        if (method) {
            data = safeExecute(JSON.stringify, [this.reqno, this.namespace + ':' + method, args, callback ? true : false], null);
        }
        if (data) {
            if (!this.sockets[this.curSock]) this.curSock = 0;
            if (callback) this.queue[this.reqno] = {
                fn: callback,
                ts: Date.now() + (delay || this.timeout)
            };
            this.sockets[this.curSock].write(data + '\n');
            this.reqno++;
            this.curSock++;
        }
    };

    Client.prototype.sendAll = function(method, args, callback, delay) {
        if (!this.sockets.length) {
            return setImmediate(this.send.bind(this), method, args, callback);
        }

        var data;
        for (var i = 0; i < this.sockets.length; i++) {
            if (method) {
                data = safeExecute(JSON.stringify, [this.reqno, this.namespace + ':' + method, args, callback ? true : false], null);
            }
            if (data) {
                if (callback) this.queue[this.reqno] = {
                    fn: callback,
                    ts: Date.now() + (delay || this.timeout)
                };
                this.sockets[i].write(data + '\n');
                this.reqno++;
            }
        }
    };
    Client.prototype.clean = function() {
        for (var i in this.queue) {
            var job = this.queue[i];
            if(job.ts < Date.now()){
                setImmediate(job.fn, new Error('Timeout'), null);
                delete this.queue[i];
            }
        }
        setTimeout(this.clean.bind(this), 100);
    };
    return new Client(namespace, config, options);
};

function safeExecute(func, data, defaultValue) {
    var result = defaultValue;

    try {
        result = func(data);
    } catch(err) {}

    return result;
}
