const express = require('express');
const app = express();
var amqplib 	= require('amqplib');	
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
var generic 	= require('../socketdemo/lib/funcgeneric');
var path 		= require('path');

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/receiver',(req,res)=> {
	res.sendFile(__dirname + '/receiver.html');
})

app.use('/public',express.static('/Users/a0s0lga/websocket/socketdemo/public'));

// io.on('connection', (socket) => {
//   console.log('a user connected in main function');
//   socket.on('chat message', (msg) => {
//     console.log('message ' + msg + " from " + socket.id);
//     socket.broadcast.emit('chat message', msg);
//   });
//   socket.on('disconnect', () => {
//     console.log('user disconnected');
//   });
// });

var APPRABMQ;
	var start = +new Date();
	amqplib.connect('amqp://admin:admin@localhost:5672?heartbeat=60').then(function(conn) {			
		APPRABMQ = conn.createChannel();	
		var end = +new Date();
		console.log("Rabbit MQ Connection Time " + (end-start) + " milliseconds");
		
		conn.on("error", function(err) {
			if (err.message !== "Connection closing") {
				console.error("Rabbit MQ Connection error", err.message);
			}
		});
		
		conn.on("close", function() {
			console.error("Rabbit MQ reconnecting");
			process.exit();
		});
	}).then(null, console.warn);
			
	var sockcnt = 0;
	var sockets = {};
	
	/*
	 When the user logs in (in our case, does http POST w/ user name), Server Side verify the JWT Token key.
	*/	
	// io.use(function(socket, next){		
	// 	if (socket.handshake.query && socket.handshake.query.token){
	// 		try {				
	// 			var decoded = jwt.verify(socket.handshake.query.token, init.SECRET_KEY,{ignoreNotBefore:true});
	// 			if(!generic.empty(decoded.data)){
	// 				var jwtId = decoded.data.id;
	// 				socket.userid = jwtId;
	// 				sockets[jwtId] = socket;
	// 				return next();
	// 			}else {					
	// 				return next(new Error('Authentication error'));					
	// 			}
	// 		} catch(err) {
	// 			console.log("Error in authentication layer")				
	// 			return next(new Error('Authentication error'));
	// 		}
	// 	} else {
	// 		next(new Error('Authentication error'));
	// 	}    
	// })
	io.on('connection', function(socket) {
    //io.on('connection',function(socket) {
      console.log('a user connected');
      socket.userid=socket.id
	  	sockcnt++;
		
		/**
		 * When a socket connection is disconnect, That time Routing Key based unbind or delete the Queue. 
		 */	
		socket.on('disconnect', function () {			
			sockcnt = sockcnt - 1;
			console.error(socket.userid,"Member Disconnect - Socket Count :",socket.id);
			if(socket.queueid && socket.userid){
				var key = socket.queueid;
				APPRABMQ.then(function(ch) {
					var ex = 'direct_logs';
					var queue_pat = 'ks_'+socket.userid;										
					var aqok = ch.unbindQueue(key,ex,queue_pat);
					aqok.then(function(q) {
						ch.deleteQueue(key);
					});
				});				
			}			
			delete sockets[socket.userid];	
			delete sockets[socket.id];			
		}); 
		
		socket.on('error', function (err) {
			console.error( socket.id+' : received error from client:',err)
		});
		
		/**
		 * When a user Logout a chat session, Routing Key based unbind or delete the Queue. 
		 */	
		socket.on("Logout", function(data,callback) 
		{	
			callback({RESPONSE:"Logout Emit is success.",uId:data.uId});
			if (!generic.empty(data.uId)){			
				var key = socket.queueid;
				APPRABMQ.then(function(ch) {
					var ex = 'direct_logs';
					var queue_pat = 'ks_'+socket.queueid;										
					var aqok = ch.unbindQueue(key,ex,queue_pat);
					aqok.then(function(q) {
						ch.deleteQueue(key);
					});
				});				
			}			
			socket.emit('RESPLOGOUT',{RC:1,ERR:0},function(lgresp){});
		});
		
		/**
		 * When a user sends a chat message, publish it to chatExchange w/o a Routing Key.		
		 */		
		socket.on("Send", function(data,callback){								
			var suId 	= data.uId;
			var spId   	= data.pId;						
			var smsg 	= data.msg;
			var srno 	= data.rno;
			var msgTime = generic.millisecTime();	
			
			callback({RESPONSE:"Send Emit is success.",uId:suId});		
			var qmsg = JSON.stringify({uId:suId,pId:spId,msg:smsg,rStatus:1,msgTime:msgTime});		
			// console.log(smsg)	
			if(APPRABMQ){
				socket.emit('RESPSEND',{RC:1,ER:0,SID:suId,RID:spId,MSG:smsg,RANDOMNO:srno,MSGTIME:msgTime,STATUS:1},function(sresp){});
				var key = 'ks_'+spId;				
				APPRABMQ.then(function(ch) {						
					var ex = 'direct_logs';	
					ch.on('return', function(msg) {
						console.log('Message returned:',msg);
					});									
															
					ch.publish(ex, key, new Buffer(qmsg), {deliveryMode: 2, mandatory: true}, function() {
						console.error('Message processed');
					});
				});			
			} else {
				socket.emit('RESPSEND',{RC:1,ER:2},function(sresp){});
			}
		});
		
		/**
		 * Initialize subscriber queue.
		 * 1. First Connect the set the Exchange name direct or fanout or topic
		 * 2. First create a queue w/o any name. This forces RabbitMQ to create new queue for every socket.io connection w/ a new random queue name.
		 * 3. Then bind the queue to chatExchange  w/ "#" or "" 'Binding key' and listen to ALL messages
		 * 4. Lastly, create a consumer (via .consume) that waits for messages from RabbitMQ. And when
		 * a message comes, send it to the browser.
		 *
		 * Note: we are creating this w/in io.on('connection'..) to create NEW queue for every connection
		 */
		var ruserId = "REC";
		if(APPRABMQ && ruserId){
			var ex = 'direct_logs';						
			var key = 'ks_'+ruserId;					
			APPRABMQ.then(function(ch) {
				//Connect the Exchange direct or fanout or topic
				var aeok = ch.assertExchange(ex, 'direct', {durable: false});
				aeok.then(function() {						
					var aqok = ch.assertQueue('',{exclusive: true});
					aqok.then(function(q) {
						socket.queueid = q.queue;
						//Bind to chatExchange w/ "#" or "" binding key to listen to all messages.
						ch.bindQueue(q.queue, ex, key);
						//Subscribe When a message comes, send it back to browser
						ch.consume(q.queue, function(msg) {
							if (msg !== null) {										
								var encodemsg = msg.content.toString();
								var quemsg = JSON.parse(encodemsg);
								if(!generic.empty(quemsg)){
									socket.emit('RESPRECEIVER',{RC:1,ER:0,MSG:[quemsg]},function(rresp){});
								} 							
							} else {
								socket.emit('RESPRECEIVER',{RC:1,ER:0},function(rresp){});
							}
						}, {noAck: true});
					});
				});
			});					
		} else{
			console.error("APP - Receiver RabbitMQ Connection is Empty:"+ruserId);
			socket.emit('RESPRECEIVER',{RC:1,ER:2},function(rresp){});
		}				
	});	

server.listen(3000, () => {
  console.log('listening on *:8081');
});

app.get('/kschat', function(req, res){
  var data = (!generic.empty(req.body)) ? req.body : req.query;
  res.render('client.ejs',{uid:data.uid,rid:data.rid,random:12232,tokenId:'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.-LyxQiT8BPIc74'});
});

