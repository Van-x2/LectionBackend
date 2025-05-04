// Updated backend code with fixed dynamic routing for Kubernetes/Fly.io

const express = require('express')
const app = express()
const cors = require('cors')
app.use(cors())
const bodyParser = require('body-parser')
app.use(bodyParser.json())
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')

// Use environment variable for port
const PORT = process.env.PORT || 3000
const uri = process.env.mongoString
const client = new MongoClient(uri)

// Store active lobbies in MongoDB instead of memory
async function getActiveLobbiesCount() {
 const db = client.db('LectionData')
 const stats = db.collection('serverStats')
 const result = await stats.findOne({ statId: 'activeLobbies' })
 return result?.count || 0
}

async function updateActiveLobbiesCount(increment) {
 const db = client.db('LectionData')
 const stats = db.collection('serverStats')
 await stats.updateOne(
   { statId: 'activeLobbies' },
   { $inc: { count: increment } },
   { upsert: true }
 )
}

// Add health check for Kubernetes
app.get('/health', (req, res) => {
 res.status(200).send('OK')
})

// Create standardized parameterized routes
app.post('/createlobby', async (req, res) => {
 await updateActiveLobbiesCount(1)
 
 // Define lobby object from request body
 const lobby = req.body
 
 try {
   await client.connect()
   
   const LectionData = client.db('LectionData')
   const activelobbies = LectionData.collection('activelobbies')
   
   // Generate unique join code
   lobby.joincode = await createJoinCode(activelobbies)
   console.log(`[${lobby.joincode}] - created`)
   
   // Insert lobby into MongoDB
   await activelobbies.insertOne(lobby)
   
   // Update host's groups
   const Users = client.db('Users')
   const hosts = Users.collection('hosts')
   
   await hosts.updateOne(
     { _id: new ObjectId(lobby.hostid) },
     { 
       $addToSet: { groups: lobby.group },
       $set: { lastgroup: lobby.group }
     }
   )
   
   // Respond with join code
   res.send({ joincode: lobby.joincode })
   
 } catch (error) {
   console.error("Error creating lobby:", error)
   res.status(500).send({ error: "Failed to create lobby" })
   await updateActiveLobbiesCount(-1)
 }
})

// Host SSE endpoint with path parameters
app.get('/lobbyhost/:joincode', async (req, res) => {
 const joincode = parseInt(req.params.joincode)
 
 // Headers for SSE
 res.writeHead(200, {
   "Connection": "keep-alive",
   "Cache-Control": "no-cache",
   "Content-Type": "text/event-stream",
 })
 res.flushHeaders()
 
 const LectionData = client.db('LectionData')
 const activelobbies = LectionData.collection('activelobbies')
 
 // Variables for polling
 let currentPolledLobby
 let lastPolledLobby
 let hostLivePoller
 let lobbyClosed = false
 
 // Set up polling interval
 hostLivePoller = setInterval(async () => {
   try {
     currentPolledLobby = await activelobbies.findOne(
       {joincode: joincode},
       { projection: { participants: 1, prompts: 1, _id: 0 } }
     )
     
     if (JSON.stringify(currentPolledLobby) !== JSON.stringify(lastPolledLobby)) {
       if (currentPolledLobby != null) {
         res.write(`data:${JSON.stringify(currentPolledLobby)}\n\n`)
       }
       lastPolledLobby = currentPolledLobby
     }
   } catch (error) {
     console.error(`Poll error for host lobby ${joincode}:`, error)
   }
 }, 1000)
 
 // Handle connection close
 res.on('close', async () => {
   clearInterval(hostLivePoller)
   
   // Close lobby if host disconnects
   if (!lobbyClosed) {
     try {
       await closeLobby(joincode)
       lobbyClosed = true
     } catch (error) {
       console.error(`Error closing lobby ${joincode}:`, error)
     }
   }
   
   res.end()
 })
})

// Client join endpoint with path parameters
app.post('/joinlobby/:joincode', async (req, res) => {
 const joincode = parseInt(req.params.joincode)
 
 try {
   const LectionData = client.db('LectionData')
   const activelobbies = LectionData.collection('activelobbies')
   
   // Check lobby status
   const statusResult = await activelobbies.findOne(
     { joincode: joincode },
     { projection: { status: 1, lobbyMembershipLevel: 1, participants: 1, _id: 0 } }
   )
   
   if (!statusResult) {
     return res.send({ message: 'PIN not recognized', joined: false })
   }

    // Checks if the lobby was created by a host with a Lection standard account
    if (statusResult.lobbyMembershipLevel == 'standard') {
    
    //If the length of the participants array is above 14, do not allow the user to join
    if (statusResult.participants.length >= 10) {
      return res.send({ message: 'Maximum amount of participants reached', joined: false })
    }
   }
   
   if (statusResult.status >= 2) {
     return res.send({ message: 'Cannot join lobby after it has started', joined: false })
   }
   
   // Add participant to lobby
   const participantBody = {
     name: req.body.name,
     userid: req.body.userid,
     responses: []
   }
   
   await activelobbies.updateOne(
     { joincode: joincode }, 
     { $push: { participants: participantBody }}
   )
   
   console.log(`[${joincode}]: ${req.body.name} added`)
   res.send({ message: 'joined the lobby', joined: true })
   
 } catch (error) {
   console.error(`Error joining lobby ${joincode}:`, error)
   res.status(500).send({ message: 'server error', joined: false })
 }
})

// Client SSE endpoint with path parameters
app.get('/lobbyclient/:joincode/:userid', async (req, res) => {
 const joincode = parseInt(req.params.joincode)
 const userid = req.params.userid
 
 // Headers for SSE
 res.writeHead(200, {
   "Connection": "keep-alive",
   "Cache-Control": "no-cache",
   "Content-Type": "text/event-stream",
 })
 res.flushHeaders()
 
 const LectionData = client.db('LectionData')
 const activelobbies = LectionData.collection('activelobbies')
 
 // Variables for polling
 let currentPolledLobby
 let lastPolledLobby
 let clientLivePoller
 
 // Set up polling interval
 clientLivePoller = setInterval(async () => {
   try {
     currentPolledLobby = await activelobbies.findOne(
       { joincode: joincode },
       { projection: { status: 1, prompts: 1, _id: 0 } }
     )
     
     if (JSON.stringify(currentPolledLobby) !== JSON.stringify(lastPolledLobby)) {
       if (currentPolledLobby != null) {
         res.write(`data:${JSON.stringify(currentPolledLobby)}\n\n`)
       }
       lastPolledLobby = currentPolledLobby
     }
   } catch (error) {
     console.error(`Poll error for client ${userid} in lobby ${joincode}:`, error)
   }
 }, 1000)
 
 // Handle connection close
 res.on('close', () => {
   clearInterval(clientLivePoller)
   res.end()
 })
})

// Client submission endpoint with path parameters
app.post('/clientsubmitresponse/:joincode/:userid', async (req, res) => {
 const joincode = parseInt(req.params.joincode)
 const userid = req.params.userid
 
 try {
   const LectionData = client.db('LectionData')
   const activelobbies = LectionData.collection('activelobbies')
   
   await activelobbies.updateOne(
     { joincode: joincode, "participants.userid": userid },
     { $push: { "participants.$.responses": req.body } }
   )
   
   res.send('received')
 } catch (error) {
   console.error(`Error submitting response for ${userid} in lobby ${joincode}:`, error)
   res.status(500).send('error')
 }
})

// Host submission endpoint with path parameters
app.post('/hostsubmitprompt/:joincode/:hostid', async (req, res) => {
  const joincode = parseInt(req.params.joincode)
  
  try {
    const LectionData = client.db('LectionData')
    const activelobbies = LectionData.collection('activelobbies')
    
    // First check if this is the first prompt (which would set the start time)
    const lobby = await activelobbies.findOne(
      { joincode: joincode },
      { projection: { status: 1, startTime: 1 } }
    )
    
    // Only set startTime if status is not 2 yet (first prompt)
    const updateData = { 
      $push: { prompts: req.body.prompt },
      $set: { status: 2 }
    }
    
    // Only add startTime if it doesn't exist yet
    if (!lobby.startTime) {
      updateData.$set.startTime = Math.floor(Date.now() / 1000)
    }
    
    await activelobbies.updateOne(
      { joincode: joincode },
      updateData
    )
    
    res.send('received')
  } catch (error) {
    console.error(`Error submitting prompt for lobby ${joincode}:`, error)
    res.status(500).send('error')
  }
})

// Host close lobby endpoint with path parameters
app.post('/hostlobbyclose/:joincode/:hostid', async (req, res) => {
 const joincode = parseInt(req.params.joincode)
 
 try {
   await closeLobby(joincode)
   res.send('lobby closed')
 } catch (error) {
   console.error(`Error closing lobby ${joincode}:`, error)
   res.status(500).send('error')
 }
})

// Helper function to create a unique join code
async function createJoinCode(collection) {
 let unique = false
 let joincode
 
 while (!unique) {
   joincode = Number((Math.floor(Math.random() * 1000000)).toString().padStart(6, '0'))
   const count = await collection.countDocuments({ joincode: joincode })
   unique = count === 0
 }
 
 return joincode
}

// Helper function to close a lobby
async function closeLobby(joincode) {
 const LectionData = client.db('LectionData')
 const activelobbies = LectionData.collection('activelobbies')
 const completedlobbies = LectionData.collection('completedlobbies')
 const Users = client.db('Users')
 const hosts = Users.collection('hosts')
 
 // Update status first
 await activelobbies.updateOne(
   { joincode: joincode },
   { $set: { status: 3 } }
 )
 
 // Wait for any pending operations
 await new Promise(resolve => setTimeout(resolve, 3000))
 
 // Get final state
 const activelobby = await activelobbies.findOne({ joincode: joincode })
 if (!activelobby) return
 
 // Calculate duration
 const nowTime = Math.floor(Date.now() / 1000)
 const startTime = activelobby.startTime || nowTime
 const duration = nowTime - startTime
 
 // Update stats
 const numberOfStudents = activelobby.participants?.length || 0
 const promptsSubmitted = activelobby.prompts?.length || 0
 
 // Update host stats
 if (activelobby.hostid) {
   await hosts.updateOne(
     { _id: new ObjectId(activelobby.hostid) },
     {
       $inc: {
         lobbyMinutesUsed: duration,
         "stats.lectionariesStarted": 1,
         "stats.studentsTaught": numberOfStudents,
         "stats.promptsSubmitted": promptsSubmitted
       }
     }
   )
 }
 
 // Add to completed lobbies
 activelobby.status = 3
 activelobby.duration = duration
 activelobby.endTime = nowTime
 
 await completedlobbies.insertOne(activelobby)
 await activelobbies.deleteOne({ joincode: joincode })
 await updateActiveLobbiesCount(-1)
 
 console.log(`[${joincode}] - completed (alive for ${duration} seconds)`)
}

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

async function gracefulShutdown() {
 console.log('Shutting down gracefully...')
 try {
   await client.close()
   server.close(() => {
     console.log('Server closed')
     process.exit(0)
   })
 } catch (error) {
   console.error('Error during shutdown:', error)
   process.exit(1)
 }
}

// Start server
const server = app.listen(PORT, () => {
 console.log(`Server listening on port: ${PORT}`)
})