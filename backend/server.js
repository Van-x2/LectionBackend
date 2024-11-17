//express import/setup
const express = require('express')
const app = express()
//cors import/setup
const cors = require('cors')
app.use(cors())
//bodyparser middleware import/setup
const bodyParser = require('body-parser')
app.use(bodyParser.json())
//env import
require('dotenv').config()
//Mongo import
const { MongoClient, ServerApiVersion, ObjectId, $match, Db } = require('mongodb')
//Defining stuffs
const PORT = 3000
const uri = process.env.mongoString
const client = new MongoClient(uri)

//Tracking how many instances / sessions are currently running on the server
let activeLobbies = 0



//initial route (the host calls this route when creating a lobby)
app.post('/createlobby', (req, res) => {
  activeLobbies++;
const thenTime = Math.floor(Date.now() / 1000)
//defines lobby object taken from request body
const lobby = req.body

//this is where we upload all data to mongoDB (a lot of data)
async function uploadLobby() {
    //defines the joincode for use later in the function
    let lobbyClosed = false
    let hostLivePoller
    let clientLivePoller
    let joincode
    //connect to MongoDB
    await client.connect()

    //gets the desired db and collection from Mongo
    const LectionData = client.db('LectionData')
    const activelobbies = LectionData.collection('activelobbies')
    const completedlobbies = LectionData.collection('completedlobbies')

    //Function to generate a unique joincode that is no more than 6 digits
    async function createJoinCode() {
        //defaults to repeating the while() loop
        let unique = false
        //if unique = false, then repeat
        while(!unique) {
          //sets a temporary joincode using some simple JS to generate the codoe
          joincode = Number((Math.floor(Math.random() * 1000000)).toString().padStart(6, '0'))
          
          //searches through the activemongoDB collection for documents matching the temp joincode
          const count = await activelobbies.countDocuments({ joincode: joincode })
          
          //if there is no matching joincodes (AKA its unique) then set unique to true
          unique = count === 0

          //if unique is true, this isnt repeated
        }
        //the temp joincode becomes permanent and is returned
        return joincode
    }

    //adds the unique joincode to the lobby object using the function created above
    lobby.joincode = await createJoinCode()
    
    //saves the joincode to a variable outside of the function scope for later use
    playerJoincode = lobby.joincode

    //inserts the lobby object into mongoDB and logs the joincode
    await activelobbies.insertOne(lobby)
    .then(result => {
      console.log(`[${lobby.joincode}] - created`)
    })

    const Users = client.db('Users')
    const hosts = Users.db('hosts')

    await hosts.updateOne(
      { _id: new ObjectId(lobby.hostid) },
      { $addToSet: { groups: lobby.group } }
    )

    //Responds to client with the created lobbies join code
    res.send({ joincode : lobby.joincode })

    //creates dynamic routes based on the current joincode
    let hostSepRouteLive = `/lobbyhost${lobby.joincode}`
    let clientSepRoute = `/joinlobby${lobby.joincode}`
    //I do this to keep instances seperate (idk if there a better way of doing this :P )

    //a route that uses server sent events to communicate with the frontend host
    app.get(hostSepRouteLive, async (req, res) => {
      //headers needed for SSE configuration
      res.writeHead(200, {
        "Connection": "keep-alive",
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      })
      //I honestly have no idea what this one does
      res.flushHeaders()

      //Defines some variables used while polling below
      let currentPolledLobby
      let lastPolledLobby

      
              //sets of interval to run every 1 seconds
      hostLivePoller = setInterval(async () => {
        //Gets 'participants' & 'prompts' fields from the MongoDB doc with the matching joincode
        currentPolledLobby = await activelobbies.findOne(
          {joincode: lobby.joincode},
          { projection: { participants: 1, prompts: 1, _id: 0 } }
        )
        //If theres a problem, log the result to console
        .catch(() => {console.log(currentPolledLobby);})
        //If there is a difference between the currently polled data vs the last polled data do something
        if((JSON.stringify(currentPolledLobby) !== JSON.stringify(lastPolledLobby))) {
          //catch any null value changes and log when it happens
          if(currentPolledLobby == null) {
          //console.log('null')
          }
          else{
            //any other changes can be sent to the front end with SSE
            res.write(`data:${JSON.stringify(currentPolledLobby)}\n\n`)
          }
          
          //reasign lastPolledLobby (to use for comparisons with modern pulled data)
          lastPolledLobby = currentPolledLobby
        }
      }, 1000)
      

      //upon a close, end the stream
      res.on('close', () => {
        if(!lobbyClosed) {
          closeLobby()
        }
        res.end()
      })
    })

    //a route that lets frontend players 'join' the lobby (AKA add their names to the DB)
    app.post(clientSepRoute, async (req, res) => {



      //looks for the lobby matching the joincode and takes only its 'status' property
      statusStatus = await activelobbies.findOne(
        {joincode: lobby.joincode},
        { projection: { status: 1, _id: 0 } }
      )
      .then(response => {
        //status meanings: 1 = initial phase (joinable to players), 2 = active phase (unjoinable to players)
        //may change this in the future to allow midgame joining from players
        if(response.status >= 2) {
          //let the client know that they cannot join 
          res.send({message: 'cannot join lobby mid-game', joined: false})
        }
        else{
          //otherwise (AKA when the status is 1 or 0)
          console.log(`[${joincode}]: ${req.body.name} added`)

          //let the client know that they have joined
          res.send({message: 'joined the lobby', joined: true})

          //builds a object to be sent to MongoDB from the request body received from the player frontend
          const participantBody = {
            name: req.body.name,
            userid: req.body.userid,
            responses: []
          }
          let nameLower = req.body.name.toLocaleLowerCase()

          //updates MongoDB with the object created above
          activelobbies.updateOne({joincode: lobby.joincode}, {$push: {participants: participantBody}})

          //creates another even MORE dynamic route for SSE to player frontend
          let clientSepRouteLive = `/lobbyclient${lobby.joincode}${nameLower}${req.body.userid}`
          /*
           I may add another layer of dynamic-ness to this route because
           there will be edge cases in which two people who use the same
           name and are in the same lobby will have the same route
           */

          //a route that uses server sent events to communicate with the player frontend
          app.get(clientSepRouteLive, async (req, res) => {
            //configures headers for SSE
            res.writeHead(200, {
              "Connection": "keep-alive",
              "Cache-Control": "no-cache",
              "Content-Type": "text/event-stream",
            })
            res.flushHeaders()


            //simmilar to the above SSE route used by host
            //sets up variables for polling
            let currentPolledLobby
            let lastPolledLobby


              clientLivePoller = setInterval(async () => {
                //views document matching the lobby joincode, and takes ONLY the prompts aray back
                currentPolledLobby = await activelobbies.findOne(
                  {joincode: lobby.joincode},
                  { projection: { status: 1, prompts: 1, _id: 0 } }
                )
                //logs the response if there is an issue
                .catch(() => {console.log(currentPolledLobby);})
                //If there is a difference between the currently polled data vs the last polled data do something
                if((JSON.stringify(currentPolledLobby) !== JSON.stringify(lastPolledLobby))) {
                  //catches and logs when a null value change is detected
                  if(currentPolledLobby == null) {
                  //console.log('null')
                  }
                  //otherwise send it to the player frontend as a SSE
                  else{
                    res.write(`data:${JSON.stringify(currentPolledLobby)}\n\n`)
                  }
                  
                  //reasign lastPolledLobby
                  lastPolledLobby = currentPolledLobby
                }
              }, 1000)
            




            res.on('close', () => {
              res.end()
            })
          })


          //another dynamic route is created
          let clientSepRouteSubmit = `/clientsubmitresponse${lobby.joincode}${nameLower}${req.body.userid}`
          //defines the name from the frontend response body before its overwritten in the next routes
          let currentName = req.body.name
          let currentID = req.body.userid

          //a route for the player frontend to submit responses to prompts created by the host
          app.post(clientSepRouteSubmit, (req, res) => {
            //respond to fufil promises
            res.send('received')
            //finds player object with matching 'currentName' property
            //updates the player object within the participants array,
            //adding the contents of the req.body to the player object's 'responses' nested array
            activelobbies.updateOne(
              { joincode: lobby.joincode, "participants.userid": currentID },
              { $push: { "participants.$.responses": req.body } },
            )
            //catch any errors, and log them
            .catch(error => console.error(error))

          })


          //another dynamic route is created this time for the host using the joincode+hostid as a unique route
          let hostSepRouteSubmit = `/hostsubmitprompt${lobby.joincode}${lobby.hostid}`

          //a route that lets hosts submit prompts to MongoDB to be shown to the player frontend clients
          app.post(hostSepRouteSubmit, (req, res) => {
            //respond to fufil promises
            res.send('received')
            //update the prompts array of the same lobby, adding the sent prompt
            activelobbies.updateOne(
              { joincode: lobby.joincode },
              { 
                $push: { prompts: req.body.prompt },
                $set: { status: 2 }
              }
            )

          })

        }
      })
    })

    //another dynamic route is created
    let hostSepRouteClose = `/hostlobbyclose${lobby.joincode}${lobby.hostid}`
          
    //a route that handles moving finished lobbies from 'activelobbies' DB to 'completedlobbies' DB
    app.post(hostSepRouteClose, async (req, res) => {
      if(!lobbyClosed) {
        closeLobby()
      }
    })
    async function closeLobby() {
    //decrement the active sessions by 1
    activeLobbies--;

    lobbyClosed = true
    //checks the current time
    const nowTime = Math.floor(Date.now() / 1000)
    //respond to fufil promises
    //res.send('lobby closed')
    
    //sets status to 3 in MongoDB
    await activelobbies.updateOne(
      { joincode: lobby.joincode },
      { $set: { status: 3 } }
    )
    setTimeout(async () => {
    clearInterval(hostLivePoller)
    clearInterval(clientLivePoller)
    //pulls the final state of the lobby from activelobbies
    const activelobby = await activelobbies.findOne({joincode: lobby.joincode})
    activelobby.status = 3
    activelobby.duration = (nowTime - thenTime)
    console.log(`[${lobby.joincode}] - completed`)
    await completedlobbies.insertOne(activelobby)
    await activelobbies.deleteOne({ joincode: lobby.joincode })
    //checks for active lobbies for 30 seconds,
    //if no lobbies are open after 30 seconds then terminate the instance
    let counter = 1
    const finalLobbyChecker = setInterval(() => {
      console.log(`[${counter*5} sec] - still checking`)
      if(counter == 7 && activeLobbies == 0) {
        console.log('closing server')
        server.close()
        setTimeout(() => {
          process.exit()
        }, 3000)
      }
      if(counter == 7 && activeLobbies >= 1) {
        console.log('there were other sessions running: continuing')
        clearInterval(finalLobbyChecker)
      }
      counter++
    }, 5000)
    }, 3500)
    }
    

    }

//calls the function, creating all this chaos lol
uploadLobby()
})




const server = app.listen(PORT, () => {
    console.log(`server listening on port: ${PORT}`)
})