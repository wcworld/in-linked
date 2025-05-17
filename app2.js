// Dependencies
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const puppeteer = require("puppeteer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

// App Configuration
const app = express();
const port = process.env.PORT || 3000;

// Create required directories if they don't exist
const puzzleDir = path.join(__dirname, "public", "images", "puzzle");
if (!fs.existsSync(puzzleDir)) {
  fs.mkdirSync(puzzleDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.static("public"));
app.use(express.static("views"));
app.use(express.json());

// State
let sessions = {};

// Utility Functions
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Puzzle and Captcha Handling Functions
async function handlePuzzleTiles(frame, browser, sessionId) {
  const tilesExist = await frame.evaluate(() => {
    const tiles = document.querySelectorAll(
      ".sc-99cwso-0.sc-1ssqylf-0.ciEslf.cKsBBz.tile.box"
    );
    return tiles.length === 6;
  });

  if (tilesExist) {
    console.log("Found puzzle tiles! Getting first tile image...");

    const blobUrl = await frame.evaluate(() => {
      const firstTile = document.querySelector(
        ".sc-99cwso-0.sc-1ssqylf-0.ciEslf.cKsBBz.tile.box"
      );
      if (!firstTile) return null;

      const style = window.getComputedStyle(firstTile);
      const backgroundImage = style.backgroundImage;

      if (backgroundImage && backgroundImage.startsWith('url("blob:')) {
        return backgroundImage.slice(5, -2);
      }
      return null;
    });

    if (blobUrl) {
      console.log("Found blob URL:", blobUrl);
      await downloadPuzzlePiece(browser, blobUrl, sessionId);
    } else {
      console.log("Could not find first puzzle piece image URL");
    }
  }
  return false;
}

async function downloadPuzzlePiece(browser, blobUrl, sessionId) {
  const newPage = await browser.newPage();
  const client = await newPage.target().createCDPSession();

  try {
    await client.send("Page.enable");
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: puzzleDir,
    });

    await newPage.goto(blobUrl);
    await newPage.evaluate((sessionId) => {
      const link = document.createElement("a");
      link.href = window.location.href;
      link.download = `puzzle_piece_${sessionId}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }, sessionId);

    await delay(2000);
    console.log(
      `Download triggered - check puzzle_piece_${sessionId}.png in the public/images/puzzle directory`
    );
  } catch (error) {
    console.error("Error during download:", error);
  } finally {
    await client.detach();
    await newPage.close();
  }
}

async function findAndClickStartPuzzleButton(frame, depth = 0, path = "") {
  console.log(
    `Checking for "Start Puzzle" button in frame at depth ${depth}: ${path}`
  );

  const foundAndClicked = await frame
    .evaluate(() => {
      const buttonSelectors = [
        'button[data-theme="home.verifyButton"]',
        "button.eZxMRy",
        "button.sc-nkuzb1-0",
        'button:has-text("Start Puzzle")',
      ];

      for (const selector of buttonSelectors) {
        try {
          const button = document.querySelector(selector);
          if (button) {
            console.log(`Found button with selector: ${selector}`);
            console.log(`Button text: ${button.textContent}`);
            button.click();
            return true;
          }
        } catch (e) {
          console.log(`Error with selector ${selector}: ${e.message}`);
        }
      }

      const buttons = document.querySelectorAll("button");
      for (const button of buttons) {
        const text = button.textContent.toLowerCase().trim();
        if (text.includes("start puzzle") || text.includes("start")) {
          console.log(`Found button with text: ${button.textContent}`);
          button.click();
          return true;
        }
      }

      return false;
    })
    .catch((error) => {
      console.log(`Error evaluating frame: ${error.message}`);
      return false;
    });

  if (foundAndClicked) {
    console.log(`🎯 CLICKED "Start Puzzle" button in frame at depth ${depth}!`);
    return true;
  }

  const childFrames = frame.childFrames();
  console.log(`Frame at depth ${depth} has ${childFrames.length} children`);

  for (let i = 0; i < childFrames.length; i++) {
    const childFrame = childFrames[i];
    const childPath = path ? `${path} > frame[${i}]` : `frame[${i}]`;
    const found = await findAndClickStartPuzzleButton(
      childFrame,
      depth + 1,
      childPath
    );
    if (found) return true;
  }

  return false;
}

async function handleCaptchaChallenge(
  page,
  browser,
  sessionId,
  challengeCount = 0
) {
  await delay(5000);

  console.log('Starting search for the "Start Puzzle" button...');
  const buttonFound = await findAndClickStartPuzzleButton(
    page.mainFrame(),
    0,
    "mainFrame"
  );

  if (buttonFound) {
    console.log('Successfully clicked the "Start Puzzle" button!');
    console.log("Waiting for puzzle tiles to appear...");
    await delay(2000);

    const allFrames = page.frames();
    for (const frame of allFrames) {
      const tilesHandled = await handlePuzzleTiles(frame, browser, sessionId);
      if (tilesHandled) {
        console.log("Puzzle solved! Waiting for URL change...");
        const currentUrl = await page.url();

        try {
          await page.waitForFunction(
            (oldUrl) => window.location.href !== oldUrl,
            { timeout: 30000 },
            currentUrl
          );
          const newUrl = await page.url();
          console.log("URL changed to:", newUrl);

          const newChallengeCount = challengeCount + 1;
          console.log(`Completed ${newChallengeCount} puzzle challenge(s)`);

          if (newChallengeCount >= 2) {
            console.log(
              "Both puzzle challenges completed. Waiting for verification code..."
            );
            const verificationCode = await askQuestion(
              "Please enter the verification code from your Gmail: "
            );

            await page.waitForSelector('input[name="pin"], input[type="text"]');
            await page.type(
              'input[name="pin"], input[type="text"]',
              verificationCode
            );

            await page.waitForSelector(
              "button.form__submit.form__submit--stretch#pin-submit-button"
            );
            await page.click(
              "button.form__submit.form__submit--stretch#pin-submit-button"
            );
            console.log("Verification code submitted!");
            return true;
          }

          console.log("Waiting for page to load completely...");
          await delay(5000);
          console.log("Checking for additional verification challenges...");

          return await handleCaptchaChallenge(
            page,
            browser,
            sessionId,
            newChallengeCount
          );
        } catch (error) {
          console.log("No URL change detected after 30 seconds");
        }
        break;
      }
    }
  } else {
    if (challengeCount >= 2) {
      console.log("Verification process appears to be complete");
    } else {
      console.log(
        "No Start Puzzle button found - verification might be complete"
      );
    }
    return true;
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

app.get("/api/check-puzzle-image", (req, res) => {
  const { sessionId } = req.query;
  const imagePath = path.join(
    __dirname,
    "public",
    "images",
    "puzzle",
    `puzzle_piece_${sessionId}.png`
  );

  if (fs.existsSync(imagePath)) {
    res.json({ exists: true });
  } else {
    res.json({ exists: false });
  }
});

app.post("/api/linkedin/login", async (req, res) => {
  let { sessionId, email, password } = req.body;

  if (!email) {
    return res.status(400).send("Email is required");
  }

  if (!sessionId) {
    sessionId = uuidv4();
  }

  if (sessions[sessionId]) {
    return res.status(400).send("Session already exists");
  }

  try {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    // Set up page configuration
    const userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
    await page.setUserAgent(userAgent);

    let result;

    // Navigate and login
    await page.goto("https://www.linkedin.com/login");

    // Wait for the input fields to be visible
    await page.waitForSelector("#username", { visible: true });
    await page.waitForSelector("#password", { visible: true });

    // Input credentials immediately
    await page.type("#username", email);
    await page.type("#password", password);

    // Click login and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }),
      page.click(".login__form_action_container button"),
    ]);

    // Check for password error
    const passwordError = await page.$("#error-for-password");
    if (passwordError) {
      console.log(
        `Invalid Email: ${email} and Password: ${password} logged for session: ${sessionId}`
      );
      result = "0";
    } else {
      console.log(
        `Email: ${email} and Password: ${password} logged for session: ${sessionId}`
      );
      result = "1";
      await delay(5000);
      sessions[sessionId] = { browser, page };
      await handleCaptchaChallenge(page, browser, sessionId, 0);
    }

    res.send(result);
  } catch (err) {
    console.error("Error in /api/linkedin/login:", err);
    res.status(500).send(err);
  }
});

app.post("/api/linkedin/security-verification", async (req, res) => {
    const { sessionId } = req.body;
  
    if (!sessionId) {
      return res.status(400).send("Session ID is required");
    }
  
    const session = sessions[sessionId];
  
    if (!session) {
      return res.status(400).send("Session not found");
    }
  
    try {
      const { page } = session;
      
      // Get puzzle tiles HTML from all frames
      const frames = page.frames();
      console.log('Number of frames found:', frames.length);
      
      for (const frame of frames) {
        console.log('Checking frame URL:', frame.url());
        const tilesHtml = await frame.evaluate(() => {
          const tiles = document.querySelectorAll('button.sc-99cwso-0.sc-1ssqylf-0.ciEslf.cKsBBz.tile.box');
          console.log('Number of tiles found:', tiles.length);
          if (tiles.length > 0) {
            // Return array of HTML for all tiles
            return Array.from(tiles).map(tile => tile.outerHTML);
          }
          return null;
        });
        
        if (tilesHtml) {
          console.log('Found tiles in frame:', frame.url());
          return res.json({ 
            status: 'success',
            tiles: tilesHtml 
          });
        }
      }
      
      console.log('No puzzle tiles found in any frame');
      res.status(404).json({ error: 'No puzzle tiles found' });
    } catch (err) {
      console.error("Error in security-verification:", err);
      res.status(500).json({ error: 'Failed to get puzzle tiles: ' + err.message });
    }
  });
  
  app.post("/api/linkedin/select-tile", async (req, res) => {
    const { sessionId, tileNumber } = req.body;
  
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
  
    if (!tileNumber || tileNumber < 1 || tileNumber > 6) {
      return res.status(400).json({ error: "Valid tile number (1-6) is required" });
    }
  
    const session = sessions[sessionId];
    if (!session) {
      return res.status(400).json({ error: "Session not found" });
    }

    let result;
  
    try {
      const { page } = session;
      const allFrames = page.frames();
      
      for (const frame of allFrames) {
        const clicked = await frame.evaluate((selectedTile) => {
          const tiles = document.querySelectorAll('.sc-99cwso-0.sc-1ssqylf-0.ciEslf.cKsBBz.tile.box');
          if (tiles[selectedTile - 1]) {
            tiles[selectedTile - 1].click();
            return true;
          }
          return false;
        }, tileNumber);
  
        if (clicked) {
          console.log(`Clicked tile number ${tileNumber}`);
          
          // Wait 3 seconds before checking
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Check for error message in all frames
          for (const frame of allFrames) {
            console.log('Checking frame:', frame.url());
            const errorMessage = await frame.evaluate(() => {
              console.log('Inside frame evaluate');
              const errorElement = document.querySelector('h2.sc-1io4bok-0.ZgnnQ.tile-game-alert.text');
              console.log('Error element found:', errorElement);
              const allElements = document.querySelectorAll('*');
              console.log('Total elements in frame:', allElements.length);
              const buttons = Array.from(document.querySelectorAll('button'));
              console.log('Number of buttons found:', buttons.length);
              const tryAgainButton = buttons.find(button => button.textContent.includes('Try again'));
              return {
                error: errorElement ? errorElement.textContent : null,
                hasTryAgain: tryAgainButton !== undefined
              };
            });
            
            if (errorMessage.error) {
              console.log('Wrong tile selected');
              if (errorMessage.hasTryAgain) {
                console.log('Try again button found');
                // Click the try again button
                await frame.evaluate(() => {
                  const buttons = Array.from(document.querySelectorAll('button'));
                  const tryAgainButton = buttons.find(button => button.textContent.includes('Try again'));
                  if (tryAgainButton) {
                    tryAgainButton.click();
                  }
                });
                console.log('Clicked try again button');
                
                // Wait for tiles to reload
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Redownload tiles
                console.log('Redownloading tiles...');
                const blobUrl = await page.evaluate(() => {
                  const img = document.querySelector('img[src*="blob:"]');
                  return img ? img.src : null;
                });
                if (blobUrl) {
                  await downloadPuzzlePiece(browser, blobUrl, sessionId);
                  console.log('Tiles redownloaded');
                } else {
                  console.log('No new puzzle image found');
                }
                
                // Wait for navigation with a timeout
                await Promise.race([
                  page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }),
                  new Promise(resolve => setTimeout(resolve, 10000))
                ]);
                
                // Wait for the image to be ready
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Download the image again
                const newBlobUrl = await page.evaluate(() => {
                  const img = document.querySelector('img[src*="blob:"]');
                  return img ? img.src : null;
                });
                if (newBlobUrl) {
                  await downloadPuzzlePiece(browser, newBlobUrl, sessionId);
                  console.log('Tiles redownloaded again');
                }
              }
              break;
            }
          }
          
          // Monitor URL changes
          const currentUrl = await page.url();
          let urlChanged = false;
          
          try {
            // Wait for navigation with a timeout
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }),
              new Promise(resolve => setTimeout(resolve, 10000))
            ]);
            
            const newUrl = await page.url();
            urlChanged = newUrl !== currentUrl;
            
            if (urlChanged) {
              console.log('URL changed from:', currentUrl, 'to:', newUrl);
              // Get only the verification header text
              const headerText = await page.evaluate(() => {
                const header = document.querySelector('h1.content__header');
                return header ? header.textContent.trim() : null;
              });
              console.log('Verification header:', headerText);

              result = headerText;
            }
            
            
            console.log('URL changed:', urlChanged && newUrl.includes('/challenge/') ? true : false);
          } catch (error) {
            result = "0";
          }
        }
      }
  
    } catch (error) {
      console.error("Error selecting tile:", error);
      res.status(500).json({ error: "Failed to select tile" });
    }
  });

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
