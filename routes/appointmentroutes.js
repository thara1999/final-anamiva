const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointmentcontroller');
const protect = require('../middlewares/authmiddleware');
const authorize = require('../middlewares/rolemiddleware');

router.post('/', protect, appointmentController.createAppointment);
router.get('/', protect, appointmentController.getAppointments);
router.get('/:appointmentId', protect, appointmentController.getAppointmentById);
router.patch('/:appointmentId/status', protect, authorize('doctor'), appointmentController.updateStatus);
router.post('/:appointmentId/cancel', protect, appointmentController.cancelAppointment);
router.patch('/:appointmentId/reschedule', protect, appointmentController.rescheduleAppointment);
router.post('/:appointmentId/notes', protect, authorize('doctor'), appointmentController.addNotes);
router.post('/:appointmentId/prescription', protect, authorize('doctor'), appointmentController.createPrescription);

// Video call routes
router.post('/:appointmentId/call/start', protect, authorize('doctor'), appointmentController.startCall);
router.post('/:appointmentId/call/join', protect, appointmentController.joinCall);
router.post('/:appointmentId/call/end', protect, appointmentController.endCall);

module.exports = router;
