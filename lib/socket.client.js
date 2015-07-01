/**
 * Created by yellow79 on 01.07.15.
 */
var net = require('net'),
    dns = require('dns'),
    common = require('./socket.common.js');

module.exports = function(namespace, config) {

    function Client(namespace, config) {
        this.namespace = namespace;

        this.servers  = [];
        if (config.host && config.port) config = [config];
        if (config.length) {
            for (var i = 0; i < config.length; i++) {
                this.servers.push({host: config[i].host, port: config[i].port});
            }
        }

        this.sockets = [];
        this.curSock = 0;
        this.doNothing = function(){};
        this.reqno = 1;
        this.queue = {};
    }

    Client.prototype.connect = function(callback) {
        var self = this;

        var real_connect = function(index) {
            var socket = new net.Socket();
            var queue = self.queue;
            self.socket = socket;

            var errback = function(err) {
                socket.removeListener('error', errback);
                setTimeout(real_connect.bind(self), 10, index);
            };
            socket.on('error', errback);

            socket.on('connect', function() {
                socket.setNoDelay(true);

                socket.removeListener('error', errback);
                socket.on('error', function(err) {
                    for (var i in queue) {
                        setImmediate(queue[i], err, null);
                        delete queue[i];
                    }
                });

                common.AddLineReader(socket);
                socket.on('line', function(data) {
                    var json = safeExecute(JSON.parse, data, []);
                    if (json[0] && queue[json[0]]) {
                        queue[json[0]](json[1], json[2]);
                        delete queue[json[0]];
                    }
                });

                if (self.sockets[index]) self.sockets[index].destroy();
                self.sockets[index] = socket;
                self.servers[index].connect = true;

                isConnect();
            });

            socket.on('close', function() {
                console.error('Server', self.servers[index].host + ':' + self.servers[index].port, 'disconnected! Trying to automatically to reconnect');
                setImmediate(real_connect.bind(self), index);
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

    Client.prototype.ping = function(callback) {
        this.send('ping', [], callback);
    };

    Client.prototype.send = function(method, args, callback) {
        if (!this.sockets.length) {
            return setImmediate(this.send, method, args, callback);
        }

        var data;
        if (method) {
            data = safeExecute(JSON.stringify, [this.reqno, this.namespace + ':' + method, args], null);
        }
        if (data) {
            if (!this.sockets[this.curSock]) this.curSock = 0;
            this.queue[this.reqno] = callback || this.doNothing;
            this.sockets[this.curSock].write(data + '\n');
            this.reqno++;
            this.curSock++;
        }
    };

    Client.prototype.sendAll = function(method, args, callback) {
        if (!this.sockets.length) {
            return setImmediate(this.send, method, args, callback);
        }

        var data;
        if (method) {
            data = safeExecute(JSON.stringify, [this.reqno, this.namespace + ':' + method, args], null);
        }
        if (data) {
            if (!this.sockets[this.curSock]) this.curSock = 0;
            this.queue[this.reqno] = callback || this.doNothing;
            for (var i = 0; i < this.sockets.length; i++) {
                this.sockets[i].write(data + '\n');
            }
            this.reqno++;
        }
    };

    return new Client(namespace, config);
};

/**
 * Безопасное выполнение функций, чтоб везде не писать конструкцию try/catch
 * @param func - функция которую надо выполнить
 * @param data - данные, передаваемые в функцию
 * @param defaultValue - дефолтное возвращаемое значение в случаи ошибочного выполнения
 * @returns {*} - возвращает результат выполнения функции func
 */
function safeExecute(func, data, defaultValue) {
    var result = defaultValue;

    try {
        result = func(data);
    } catch(err) {}

    return result;
}