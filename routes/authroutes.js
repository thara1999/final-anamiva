const express = require("express");
const router = express.Router();
const authController = require("../controllers/authcontroller");
const protectTemp = require("../middlewares/authmiddleware"); // temp token also JWT
const upload = require("../config/storage");

router.post("/send-otp", authController.sendOtp);
router.post("/verify-otp", authController.verifyOtp);

router.post("/select-role", protectTemp, authController.selectRole);
router.post("/complete-profile", protectTemp, authController.completeProfile);

router.get("/me", protectTemp, authController.getMe);
router.post("/logout", protectTemp, authController.logout);
router.put("/profile", protectTemp, authController.updateProfile);
router.post("/upload-avatar", protectTemp, upload.single("avatar"), authController.uploadAvatar);

module.exports = router;
